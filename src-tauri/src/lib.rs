// Tauri 2 entry point.
//
// On startup we spawn the Python FastAPI sidecar (whisper_sidecar) as a child
// process. The sidecar prints a single line `SIDECAR_READY <port>\n` to stdout
// once it has bound an ephemeral TCP port. We parse that line, store the
// resulting `http://127.0.0.1:<port>` URL in Tauri managed state, expose it to
// the frontend through both:
//
//   1. A Tauri command `get_sidecar_url()` (async fallback).
//   2. A direct `window.__SIDECAR_URL__` injection via `webview.eval(...)`
//      so the React app can read it synchronously without an IPC round-trip.
//
// The child process is tracked so we can kill it cleanly when the main window
// closes (preventing orphan processes).
//
// NOTE for the frontend team — contract for `src/lib/sidecar.ts`:
//   - `window.__SIDECAR_URL__` is set BEFORE the React app first renders. If
//     it is missing (e.g. sidecar failed to boot), fall back to
//     `invoke<string>('get_sidecar_url')` which returns the URL or an Err.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::sync_channel;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};

/// Managed state holding the resolved sidecar URL and the live child process.
struct SidecarState {
    url: Mutex<Option<String>>,
    child: Mutex<Option<Child>>,
}

impl SidecarState {
    fn new() -> Self {
        Self {
            url: Mutex::new(None),
            child: Mutex::new(None),
        }
    }
}

/// Tauri command exposed to the frontend. Returns the sidecar URL once
/// available, or an error string if the sidecar is not ready.
#[tauri::command]
fn get_sidecar_url(state: State<'_, SidecarState>) -> Result<String, String> {
    state
        .url
        .lock()
        .map_err(|e| format!("sidecar state poisoned: {e}"))?
        .clone()
        .ok_or_else(|| "sidecar not ready".to_string())
}

/// Demo greet command, kept from the scaffold.
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Resolve the sidecar directory, branching on dev vs bundled.
///
/// - Dev (`debug_assertions`): walk up from cwd until we find `python-sidecar/`
///   with a `pyproject.toml`. The bundled venv may not even exist yet.
/// - Release: read from the Tauri resource dir, which is populated from the
///   `bundle.resources` entry in `tauri.conf.json`. The path inside the .app
///   is `Contents/Resources/python-sidecar/`.
fn resolve_sidecar_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let cwd = std::env::current_dir().map_err(|e| format!("cwd unavailable: {e}"))?;
        for ancestor in cwd.ancestors() {
            let candidate = ancestor.join("python-sidecar");
            if candidate.join("pyproject.toml").exists() {
                return Ok(candidate);
            }
        }
        return Err(format!(
            "python-sidecar/ not found relative to {}",
            cwd.display()
        ));
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir unavailable: {e}"))?;
    let candidate = resource_dir.join("python-sidecar");
    if !candidate.exists() {
        return Err(format!(
            "bundled python-sidecar not found at {}",
            candidate.display()
        ));
    }
    Ok(candidate)
}

/// Locate the `uv` binary. Tauri apps do NOT inherit the user's interactive
/// shell `PATH`, so a bare `uv` lookup typically fails. We probe a list of
/// common install locations and return the first existing one.
///
/// Order: the official `uv` installer drops the binary in `~/.local/bin`, so
/// we check that first; then a Cargo-installed `uv` (`~/.cargo/bin`); then
/// the two Homebrew prefixes (Apple Silicon, then Intel/generic).
///
/// Only needed in dev mode — release builds invoke the bundled venv's python
/// directly. `cfg(debug_assertions)` keeps the function out of release binaries
/// and silences the dead-code warning.
#[cfg(debug_assertions)]
fn locate_uv() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        PathBuf::from(format!("{home}/.local/bin/uv")),
        PathBuf::from(format!("{home}/.cargo/bin/uv")),
        PathBuf::from("/opt/homebrew/bin/uv"),
        PathBuf::from("/usr/local/bin/uv"),
    ];
    for path in candidates.iter() {
        if path.exists() {
            return Ok(path.clone());
        }
    }
    Err(format!(
        "uv binary not found. Tried: {}",
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

/// Spawn the sidecar, parse the `SIDECAR_READY <port>` handshake line, and
/// return the live `Child` plus the resolved `http://127.0.0.1:<port>` URL.
///
/// Dev: invokes `uv run python -m whisper_sidecar` against the project's dev
/// venv. Release: invokes the bundled venv's python directly with PYTHONPATH
/// pointing at the bundled whisper_sidecar package — `uv` is not required on
/// the user's machine.
fn spawn_sidecar(app: &AppHandle) -> Result<(Child, String), String> {
    let sidecar_dir = resolve_sidecar_dir(app)?;

    // The dev/release branches reference different symbols (`locate_uv` is
    // dev-only), so we gate them with `#[cfg]` instead of `cfg!()` — the
    // latter is a runtime expression and would still try to type-check
    // `locate_uv()` in release mode where it doesn't exist.
    #[cfg(debug_assertions)]
    let mut command = {
        let uv = locate_uv()?;
        let mut c = Command::new(&uv);
        c.args(["run", "python", "-m", "whisper_sidecar", "--port", "0"])
            .current_dir(&sidecar_dir);
        c
    };

    #[cfg(not(debug_assertions))]
    let mut command = {
        // Bundled: <resource>/python-sidecar/.venv-bundle/bin/python and
        // PYTHONPATH=<resource>/python-sidecar/src so the package is importable
        // without depending on an editable install (which would carry an
        // absolute path baked at build time and defeat relocation).
        let python = sidecar_dir.join(".venv-bundle/bin/python");
        if !python.exists() {
            return Err(format!(
                "bundled python interpreter missing at {}",
                python.display()
            ));
        }
        let pkg_root = sidecar_dir.join("src");
        let mut c = Command::new(&python);
        c.args(["-m", "whisper_sidecar", "--port", "0"])
            .current_dir(&sidecar_dir)
            .env("PYTHONPATH", &pkg_root);
        c
    };

    let mut child = command
        .stdout(Stdio::piped())
        // Surface Python tracebacks / uvicorn logs in the parent's stderr so
        // dev mode shows them in the terminal that launched `tauri dev`.
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn whisper_sidecar: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "child stdout was not piped".to_string())?;

    // sync_channel(1) — single-shot handshake. The reader thread sends exactly
    // one Result with either the port string or an error explaining what went
    // wrong (EOF before the line, IO error, etc.).
    let (tx, rx) = sync_channel::<Result<u16, String>>(1);

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if let Some(rest) = line.strip_prefix("SIDECAR_READY ") {
                        match rest.trim().parse::<u16>() {
                            Ok(port) => {
                                let _ = tx.send(Ok(port));
                                return;
                            }
                            Err(e) => {
                                let _ = tx.send(Err(format!(
                                    "could not parse port from `{line}`: {e}"
                                )));
                                return;
                            }
                        }
                    }
                    // Any other stdout line is ignored — once SIDECAR_READY is
                    // seen we stop caring about stdout (the sidecar logs to
                    // stderr anyway).
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("error reading sidecar stdout: {e}")));
                    return;
                }
            }
        }
        // EOF without a SIDECAR_READY line — most likely the sidecar crashed
        // at import time. The traceback was already piped to stderr.
        let _ = tx.send(Err(
            "sidecar exited before printing SIDECAR_READY <port>".to_string(),
        ));
    });

    // 10s is generous: uv usually starts in <1s once the venv exists, but the
    // first `uv run` in a fresh checkout can take a moment to resolve.
    let port = match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(port)) => port,
        Ok(Err(e)) => {
            let _ = child.kill();
            return Err(e);
        }
        Err(_) => {
            let _ = child.kill();
            return Err("timed out waiting for SIDECAR_READY (10s)".to_string());
        }
    };

    let url = format!("http://127.0.0.1:{port}");
    Ok((child, url))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(SidecarState::new())
        .setup(|app| {
            let state: State<'_, SidecarState> = app.state();
            let app_handle = app.handle().clone();

            match spawn_sidecar(&app_handle) {
                Ok((child, url)) => {
                    eprintln!("[sidecar] ready at {url}");

                    // Persist into managed state before any frontend call can
                    // race against us.
                    *state.url.lock().unwrap() = Some(url.clone());
                    *state.child.lock().unwrap() = Some(child);

                    // Inject the URL into the main webview. If the window
                    // isn't ready yet, Tauri queues the eval until it is.
                    if let Some(window) = app.get_webview_window("main") {
                        // URL is a host-controlled value (just an int port) so
                        // escaping is unnecessary, but we still emit the URL
                        // through JSON to be safe against any future shape
                        // changes.
                        let js = format!("window.__SIDECAR_URL__ = {};", serde_json::to_string(&url).unwrap());
                        if let Err(e) = window.eval(&js) {
                            eprintln!("[sidecar] failed to inject __SIDECAR_URL__: {e}");
                        }
                    } else {
                        eprintln!("[sidecar] main window not yet available; URL only reachable via get_sidecar_url command");
                    }
                }
                Err(e) => {
                    // Surface a user-visible dialog so a missing `uv` or a
                    // crashing sidecar doesn't fail silently in dev.
                    eprintln!("[sidecar] failed to start: {e}");
                    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                    let _ = app
                        .dialog()
                        .message(format!(
                            "The transcription sidecar failed to start.\n\n{e}\n\nSee the terminal for details."
                        ))
                        .title("Echo Script — sidecar error")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                    // Don't fail the setup — we still want the app window to
                    // render so the user can see the error state. The
                    // frontend will get an Err from get_sidecar_url().
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // When the main window is destroyed, kill the sidecar so it
            // doesn't outlive the UI.
            if matches!(event, WindowEvent::Destroyed) && window.label() == "main" {
                let state: State<'_, SidecarState> = window.state();
                let taken = state.child.lock().unwrap().take();
                if let Some(mut child) = taken {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![greet, get_sidecar_url])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Last-chance cleanup on app exit (covers panics, ctrl-c in dev,
            // and any path that doesn't trigger WindowEvent::Destroyed).
            if let RunEvent::Exit = event {
                let state: State<'_, SidecarState> = app_handle.state();
                let taken = state.child.lock().unwrap().take();
                if let Some(mut child) = taken {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
