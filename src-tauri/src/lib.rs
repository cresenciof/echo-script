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

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::sync_channel;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

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

// ---------------------------------------------------------------------------
// Subtitle muxing
// ---------------------------------------------------------------------------
//
// `export_subtitled_video` takes the original video path, a list of transcript
// segments coming from the sidecar, and produces an output video with either:
//   - soft subtitles (mov_text track inside the mp4 container), or
//   - burned-in subtitles (re-encoded video with the SRT rendered into pixels).
//
// We reuse the static ffmpeg binary that ships inside the Python sidecar's
// bundled venv (`python-sidecar/.venv-bundle/bin/ffmpeg`, an LGPL build from
// evermeet.cx) instead of bundling a second copy.

/// Transcript segment as serialized from the frontend.
#[derive(serde::Deserialize)]
struct SegmentDto {
    start: f64,
    end: f64,
    text: String,
}

/// Progress event payload emitted on the `ffmpeg_progress` window event during
/// long-running exports (mainly burn-in). `out_time_s` is the source-stream
/// timestamp ffmpeg has finished processing, in seconds; `total_s` is the
/// expected total duration if known (we pass `None` when we don't have it).
#[derive(serde::Serialize, Clone)]
struct FfmpegProgress {
    out_time_s: f64,
    total_s: Option<f64>,
    /// `running` while frames are still being processed, `done` on completion.
    status: &'static str,
}

/// Resolve the bundled ffmpeg binary path, dev or release.
fn resolve_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let cwd = std::env::current_dir().map_err(|e| format!("cwd unavailable: {e}"))?;
        for ancestor in cwd.ancestors() {
            let candidate = ancestor.join("python-sidecar/.venv-bundle/bin/ffmpeg");
            if candidate.exists() {
                return Ok(candidate);
            }
        }
        // Fall back to ffmpeg on PATH so devs without the bundled venv can
        // still test the feature.
        if let Ok(out) = Command::new("which").arg("ffmpeg").output() {
            if out.status.success() {
                let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !path.is_empty() {
                    return Ok(PathBuf::from(path));
                }
            }
        }
        return Err(format!(
            "ffmpeg not found: looked for python-sidecar/.venv-bundle/bin/ffmpeg under {} and on PATH",
            cwd.display()
        ));
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir unavailable: {e}"))?;
    let candidate = resource_dir.join("python-sidecar/.venv-bundle/bin/ffmpeg");
    if !candidate.exists() {
        return Err(format!(
            "bundled ffmpeg not found at {}",
            candidate.display()
        ));
    }
    Ok(candidate)
}

/// Render a single SRT timecode: `00:12:34,560`. Mirrors `formatSRTTime` in
/// `src/lib/timeFormat.ts` so soft-subtitled output matches the SRT export.
fn format_srt_time(seconds: f64) -> String {
    let clamped = if !seconds.is_finite() || seconds < 0.0 {
        0.0
    } else {
        seconds
    };
    let total = clamped.floor() as u64;
    let ms = (((clamped - total as f64) * 1000.0).round()).clamp(0.0, 999.0) as u64;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    format!("{:02}:{:02}:{:02},{:03}", h, m, s, ms)
}

/// Build an SRT body from segments.
fn build_srt(segments: &[SegmentDto]) -> String {
    let mut out = String::new();
    for (i, seg) in segments.iter().enumerate() {
        out.push_str(&(i + 1).to_string());
        out.push('\n');
        out.push_str(&format_srt_time(seg.start));
        out.push_str(" --> ");
        out.push_str(&format_srt_time(seg.end));
        out.push('\n');
        out.push_str(seg.text.trim());
        out.push_str("\n\n");
    }
    out
}

/// Write `contents` to a freshly-created `.srt` file in the OS temp dir.
/// Returns the absolute path. We deliberately do NOT delete the file on
/// success — it's <100 KB and the OS sweeps temp periodically; keeping it
/// also helps users debug bad outputs.
fn write_temp_srt(contents: &str) -> Result<PathBuf, String> {
    let mut path = std::env::temp_dir();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    path.push(format!("echo-script-subs-{}.srt", stamp));

    let mut file = std::fs::File::create(&path)
        .map_err(|e| format!("failed to create temp srt at {}: {e}", path.display()))?;
    file.write_all(contents.as_bytes())
        .map_err(|e| format!("failed to write temp srt: {e}"))?;
    Ok(path)
}

/// Escape an SRT path for use inside ffmpeg's `subtitles=...` lavfi filter
/// argument. The lavfi parser splits on `:` (option separator) and `,` (filter
/// separator), and treats `\` as escape. Paths with spaces or `:` MUST be
/// quoted; we use single quotes and escape backslashes / single quotes inside.
fn escape_lavfi_path(path: &str) -> String {
    // Replace backslashes first, then single quotes. Inside a single-quoted
    // lavfi argument, the only escape that matters is `\'`.
    path.replace('\\', "\\\\").replace('\'', "\\'")
}

#[tauri::command]
async fn export_subtitled_video(
    app: AppHandle,
    input_video_path: String,
    transcript_segments: Vec<SegmentDto>,
    output_path: String,
    mode: String,
) -> Result<String, String> {
    if transcript_segments.is_empty() {
        return Err("transcript has no segments to mux".to_string());
    }
    if mode != "soft" && mode != "burn" {
        return Err(format!("unknown mode `{mode}`, expected `soft` or `burn`"));
    }

    let input = PathBuf::from(&input_video_path);
    if !input.exists() {
        return Err(format!("input video not found: {}", input.display()));
    }

    let ffmpeg = resolve_ffmpeg(&app)?;
    let srt_body = build_srt(&transcript_segments);
    let srt_path = write_temp_srt(&srt_body)?;

    // Total duration for progress percentage — derived from the segments since
    // we don't ffprobe. End of the last segment is a good lower bound.
    let total_s: Option<f64> = transcript_segments
        .last()
        .map(|s| s.end)
        .filter(|v| v.is_finite() && *v > 0.0);

    // -progress pipe:1 emits `key=value` lines (one per chunk) to stdout. We
    // tail stdout in a thread and forward an `ffmpeg_progress` event every
    // ~500ms so the frontend can render a progress bar without spam.
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        "-i".into(),
        input.to_string_lossy().into_owned(),
    ];

    if mode == "soft" {
        args.extend([
            "-i".into(),
            srt_path.to_string_lossy().into_owned(),
            "-c".into(),
            "copy".into(),
            "-c:s".into(),
            "mov_text".into(),
            output_path.clone(),
        ]);
    } else {
        let escaped = escape_lavfi_path(&srt_path.to_string_lossy());
        let vf = format!(
            "subtitles='{}':force_style='FontSize=18,Outline=1,Shadow=1'",
            escaped
        );
        args.extend([
            "-vf".into(),
            vf,
            "-c:a".into(),
            "copy".into(),
            output_path.clone(),
        ]);
    }

    let mut child = Command::new(&ffmpeg)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    // Progress thread — reads `out_time_us=` lines from stdout, throttled to
    // ~2 emits/second. Owns the stdout handle.
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ffmpeg stdout was not piped".to_string())?;
    let progress_app = app.clone();
    let progress_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        let mut last_out_time_s = 0.0_f64;
        for line in reader.lines().map_while(Result::ok) {
            // ffmpeg's `-progress` emits `out_time_us=NNNN` and
            // `out_time_ms=NNNN` (despite the name, often microseconds in
            // recent builds). `out_time_us` is unambiguous; fall back to
            // `out_time_ms` parsed as microseconds.
            let parsed = line
                .strip_prefix("out_time_us=")
                .and_then(|v| v.trim().parse::<i64>().ok())
                .or_else(|| {
                    line.strip_prefix("out_time_ms=")
                        .and_then(|v| v.trim().parse::<i64>().ok())
                });
            if let Some(us) = parsed {
                if us >= 0 {
                    last_out_time_s = us as f64 / 1_000_000.0;
                    if last_emit.elapsed() >= Duration::from_millis(500) {
                        let _ = progress_app.emit(
                            "ffmpeg_progress",
                            FfmpegProgress {
                                out_time_s: last_out_time_s,
                                total_s,
                                status: "running",
                            },
                        );
                        last_emit = Instant::now();
                    }
                }
            } else if line.starts_with("progress=end") {
                let _ = progress_app.emit(
                    "ffmpeg_progress",
                    FfmpegProgress {
                        out_time_s: last_out_time_s,
                        total_s,
                        status: "done",
                    },
                );
            }
        }
    });

    // Capture stderr so we can return a useful error message on failure.
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "ffmpeg stderr was not piped".to_string())?;
    let stderr_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut buf = String::new();
        for line in reader.lines().map_while(Result::ok) {
            buf.push_str(&line);
            buf.push('\n');
            // Bound the buffer so a chatty ffmpeg can't blow up memory.
            if buf.len() > 64 * 1024 {
                let drop_to = buf.len() - 32 * 1024;
                buf.drain(..drop_to);
            }
        }
        buf
    });

    let status = child
        .wait()
        .map_err(|e| format!("failed to wait for ffmpeg: {e}"))?;
    let _ = progress_handle.join();
    let stderr_tail = stderr_handle.join().unwrap_or_default();

    if !status.success() {
        let tail = stderr_tail
            .lines()
            .rev()
            .take(20)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!(
            "ffmpeg exited with status {}: {}",
            status.code().unwrap_or(-1),
            tail
        ));
    }

    // Resolve output to an absolute path for the success message.
    let abs_output = Path::new(&output_path)
        .canonicalize()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(output_path);
    Ok(abs_output)
}

/// Pre-compute waveform peaks via the bundled ffmpeg so the renderer
/// doesn't depend on the WKWebView's Web Audio decoder (which fails on
/// m4a / AAC and a few other Apple-ecosystem containers).
///
/// Decodes `audio_path` to mono 16-bit PCM at a low sample rate, walks
/// the samples in N buckets, and returns the max absolute value per
/// bucket (normalised to -1..1) plus the precise duration. wavesurfer.js
/// consumes the array via its `peaks` option, skipping its own
/// fetch+decode entirely.
#[derive(serde::Serialize)]
struct PeaksResponse {
    peaks: Vec<f32>,
    duration_s: f64,
    sample_rate: u32,
}

#[tauri::command]
async fn compute_audio_peaks(
    app: AppHandle,
    audio_path: String,
    target_peaks: u32,
) -> Result<PeaksResponse, String> {
    if !Path::new(&audio_path).is_file() {
        return Err(format!("audio file not found: {audio_path}"));
    }
    if target_peaks == 0 {
        return Err("target_peaks must be > 0".to_string());
    }

    let ffmpeg = resolve_ffmpeg(&app)?;

    // 1 kHz mono i16 is plenty for a visual waveform — ~120 KB/min raw.
    // We don't need full audio fidelity here; we only need the envelope.
    const SAMPLE_RATE: u32 = 1000;

    // Hard memory cap: refuse to keep more than this many bytes of raw PCM in
    // RAM. At 1 kHz mono i16 (2 KB/s) this caps the effective audio length
    // at ~6 hours — well past any reasonable transcription target, and well
    // before we contribute to system memory pressure.
    const MAX_PCM_BYTES: usize = 50 * 1024 * 1024; // 50 MB

    let mut child = Command::new(&ffmpeg)
        .args([
            "-v", "error",
            "-i", &audio_path,
            // -vn: drop any video stream before decode. Without this,
            // dropping a 4K .mp4 here would push ffmpeg to also process the
            // video frames, which on a memory-pressured Mac can spiral into
            // an OOM and (transitively) a kernel watchdog panic.
            "-vn",
            "-f", "s16le",
            "-ac", "1",
            "-ar", &SAMPLE_RATE.to_string(),
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to invoke ffmpeg: {e}"))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ffmpeg stdout pipe missing".to_string())?;
    let stderr_handle = child.stderr.take();

    // Read in fixed-size chunks instead of `read_to_end` so we can bail out
    // if the file is unreasonably large before the Vec grows unbounded.
    let mut buf: Vec<u8> = Vec::with_capacity(1024 * 1024);
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let n = std::io::Read::read(&mut stdout, &mut chunk)
            .map_err(|e| format!("failed to read ffmpeg stdout: {e}"))?;
        if n == 0 {
            break;
        }
        if buf.len() + n > MAX_PCM_BYTES {
            // Kill ffmpeg immediately to free its own buffers, then bail.
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "audio too long for waveform preview: > {} MB of PCM",
                MAX_PCM_BYTES / 1024 / 1024
            ));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let status = child
        .wait()
        .map_err(|e| format!("ffmpeg wait failed: {e}"))?;
    if !status.success() {
        let stderr_text = stderr_handle
            .and_then(|mut s| {
                let mut t = String::new();
                std::io::Read::read_to_string(&mut s, &mut t).ok().map(|_| t)
            })
            .unwrap_or_default();
        return Err(format!(
            "ffmpeg failed (exit {}): {}",
            status.code().unwrap_or(-1),
            stderr_text.lines().rev().take(5).collect::<Vec<_>>().join(" | ")
        ));
    }

    if buf.len() < 2 {
        return Err("ffmpeg produced no audio samples".to_string());
    }
    let sample_count = buf.len() / 2;
    let samples_iter = (0..sample_count).map(|i| {
        i16::from_le_bytes([buf[i * 2], buf[i * 2 + 1]])
    });

    // Bucket the samples into `target_peaks` bins. Each bin's peak is the
    // max absolute value normalised to -1..1.
    let n = target_peaks as usize;
    let mut peaks = vec![0.0_f32; n];
    if sample_count > 0 {
        let chunk_size = (sample_count + n - 1) / n; // ceiling div
        for (i, s) in samples_iter.enumerate() {
            let bin = (i / chunk_size).min(n - 1);
            let amp = (s.unsigned_abs() as f32) / 32768.0;
            if amp > peaks[bin] {
                peaks[bin] = amp;
            }
        }
    }

    let duration_s = sample_count as f64 / SAMPLE_RATE as f64;
    Ok(PeaksResponse {
        peaks,
        duration_s,
        sample_rate: SAMPLE_RATE,
    })
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
        .invoke_handler(tauri::generate_handler![
            greet,
            get_sidecar_url,
            export_subtitled_video,
            compute_audio_peaks,
        ])
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
