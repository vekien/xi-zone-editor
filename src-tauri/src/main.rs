// XI Zone Editor — Tauri shell.
// Frontend (../ui) is the level editor. This process downloads/runs xi-tools'
// WebSocket bridge and kills it when the app exits.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use once_cell::sync::Lazy;
use serde::Serialize;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, copy, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const GH_OWNER: &str = "vekien";
const GH_REPO: &str = "xi-tools";
const BRIDGE_HOST: &str = "127.0.0.1";
const BRIDGE_PORT: u16 = 8777;
const BRIDGE_IDLE_SECS: u32 = 90;

static BRIDGE_CHILD: Lazy<Mutex<Option<Child>>> = Lazy::new(|| Mutex::new(None));

#[cfg(windows)]
mod job {
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::ptr;
    use std::sync::OnceLock;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attrs: *mut core::ffi::c_void, name: *const u16) -> *mut core::ffi::c_void;
        fn SetInformationJobObject(
            job: *mut core::ffi::c_void,
            class: i32,
            info: *mut core::ffi::c_void,
            len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: *mut core::ffi::c_void, process: *mut core::ffi::c_void) -> i32;
    }

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;

    #[repr(C)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        min_ws: usize,
        max_ws: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct IO_COUNTERS {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }

    #[repr(C)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        basic: JOBOBJECT_BASIC_LIMIT_INFORMATION,
        io: IO_COUNTERS,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }

    static JOB: OnceLock<isize> = OnceLock::new();

    fn job_handle() -> isize {
        *JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(ptr::null_mut(), ptr::null());
            if h.is_null() {
                return 0;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                h,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                &mut info as *mut _ as *mut _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                return 0;
            }
            h as isize
        })
    }

    pub fn attach(child: &Child) {
        let job = job_handle();
        if job == 0 {
            return;
        }
        unsafe {
            let _ = AssignProcessToJobObject(job as *mut _, child.as_raw_handle() as *mut _);
        }
    }
}

#[cfg(not(windows))]
mod job {
    use std::process::Child;
    pub fn attach(_child: &Child) {}
}

fn load_dotenv() {
    if let Some(f) = env_path("XI_ENV_FILE") {
        if dotenvy::from_path(&f).is_ok() {
            return;
        }
    }
    if dotenvy::dotenv().is_ok() {
        return;
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let _ = dotenvy::from_path(dir.join(".env"));
        }
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    let v = std::env::var(name).ok()?;
    let v = v.trim();
    (!v.is_empty()).then(|| PathBuf::from(v))
}

fn app_data_dir() -> PathBuf {
    env_path("XI_ZONE_EDITOR_DATA")
        .or_else(|| {
            std::env::var("LOCALAPPDATA")
                .ok()
                .map(|p| PathBuf::from(p).join("XiZoneEditor"))
        })
        .or_else(|| {
            env_path("HOME").map(|h| h.join(".cache").join("XiZoneEditor"))
        })
        .unwrap_or_else(|| std::env::temp_dir().join("XiZoneEditor"))
}

fn tools_override_path() -> PathBuf {
    app_data_dir().join("xi-tools-path.txt")
}

/// Active xi-tools root: explicit override (local checkout) wins, else the
/// downloaded install under app data.
fn xi_tools_dir() -> PathBuf {
    if let Ok(s) = fs::read_to_string(tools_override_path()) {
        let p = PathBuf::from(s.trim());
        if p.is_dir() && p.join("src").join("xi").is_dir() {
            return p;
        }
    }
    if let Some(p) = env_path("XI_TOOLS_DIR") {
        if p.is_dir() && p.join("src").join("xi").is_dir() {
            return p;
        }
    }
    app_data_dir().join("xi-tools")
}

fn validate_tools_dir(dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Err(format!("Not a folder: {}", dir.display()));
    }
    if !dir.join("src").join("xi").is_dir() {
        return Err(format!(
            "That folder doesn't look like an xi-tools checkout.\n\
             Expected: {}\\src\\xi\\",
            dir.display()
        ));
    }
    Ok(())
}

fn version_path() -> PathBuf {
    xi_tools_dir().join("version.txt")
}

fn read_local_version() -> String {
    fs::read_to_string(version_path())
        .map(|s| s.trim().trim_start_matches('v').to_string())
        .unwrap_or_else(|_| "0.0.0".into())
}

fn normalize_version(v: &str) -> String {
    v.trim().trim_start_matches('v').to_string()
}

fn is_newer(remote: &str, local: &str) -> bool {
    let r = normalize_version(remote);
    let l = normalize_version(local);
    let parse = |s: &str| -> Option<(u64, u64, u64)> {
        let mut it = s.split(|c| c == '.' || c == '-' || c == '_');
        let a = it.next()?.parse().ok()?;
        let b = it.next().unwrap_or("0").parse().ok()?;
        let c = it.next().unwrap_or("0").parse().ok()?;
        Some((a, b, c))
    };
    match (parse(&r), parse(&l)) {
        (Some(rv), Some(lv)) => rv > lv,
        _ => !r.eq_ignore_ascii_case(&l),
    }
}

fn install_complete(dir: &Path) -> bool {
    // Package present is enough to call it "installed"; bridge start separately
    // resolves Python (bundled or system). Don't treat Store stubs as Python.
    dir.join("src").join("xi").is_dir()
}

fn which(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
        #[cfg(windows)]
        {
            let p2 = dir.join(format!("{name}.exe"));
            if p2.is_file() {
                return Some(p2);
            }
        }
    }
    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolsStatus {
    installed: bool,
    local_version: String,
    latest_version: Option<String>,
    update_available: bool,
    tools_dir: String,
    /// True when tools_dir is a user-picked local checkout (not the download cache).
    using_local_override: bool,
    bridge_url: String,
    bridge_running: bool,
    error: Option<String>,
}

/// Fired on the `tools-progress` event while install / Python setup runs.
/// Each stage resets `pct` to 0 so the splash bar can restart cleanly.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolsProgress {
    stage: String,
    label: String,
    loaded: u64,
    total: Option<u64>,
    pct: f64,
    /// "bytes" | "files" | "none"
    unit: String,
    detail: Option<String>,
}

fn emit_progress(
    app: &AppHandle,
    stage: &str,
    label: &str,
    loaded: u64,
    total: Option<u64>,
    unit: &str,
    detail: Option<String>,
) {
    let pct = match total {
        Some(t) if t > 0 => (loaded as f64 / t as f64) * 100.0,
        _ => 0.0,
    };
    let _ = app.emit(
        "tools-progress",
        ToolsProgress {
            stage: stage.into(),
            label: label.into(),
            loaded,
            total,
            pct: pct.clamp(0.0, 100.0),
            unit: unit.into(),
            detail,
        },
    );
}

/// Append a line to the splash CLI log (`tools-log` event).
fn emit_log(app: &AppHandle, line: impl AsRef<str>) {
    let s = line.as_ref().trim_end();
    if s.is_empty() {
        return;
    }
    let _ = app.emit("tools-log", s.to_string());
}

/// Pump a child pipe into the splash log on a background thread.
fn pump_log_pipe<R: Read + Send + 'static>(app: Option<AppHandle>, reader: R) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let buf = BufReader::new(reader);
        for line in buf.lines().flatten() {
            if let Some(ref app) = app {
                emit_log(app, line);
            }
        }
    })
}

fn gh_client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .user_agent("xi-zone-editor")
        .timeout(Duration::from_secs(120))
        .build()
        .expect("http client")
}

fn fetch_latest_release() -> Result<serde_json::Value, String> {
    let url = format!("https://api.github.com/repos/{GH_OWNER}/{GH_REPO}/releases/latest");
    let mut req = gh_client().get(&url);
    if let Ok(tok) = std::env::var("GITHUB_TOKEN") {
        if !tok.trim().is_empty() {
            req = req.bearer_auth(tok.trim());
        }
    }
    let resp = req.send().map_err(|e| format!("GitHub request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub HTTP {}", resp.status()));
    }
    resp.json().map_err(|e| format!("bad GitHub JSON: {e}"))
}

/// Disk-only status — no network. Safe to call from the UI thread path and after
/// install without re-hitting GitHub.
fn tools_status_local() -> ToolsStatus {
    let dir = xi_tools_dir();
    let local = read_local_version();
    let installed = install_complete(&dir);
    let using_override = tools_override_path().is_file()
        || env_path("XI_TOOLS_DIR").map(|p| p == dir).unwrap_or(false);
    ToolsStatus {
        installed,
        local_version: local,
        latest_version: None,
        update_available: false,
        tools_dir: dir.display().to_string(),
        using_local_override: using_override,
        bridge_url: format!("ws://{BRIDGE_HOST}:{BRIDGE_PORT}/ws"),
        bridge_running: port_open(BRIDGE_HOST, BRIDGE_PORT),
        error: None,
    }
}

/// Full status including a GitHub latest-release check. May take several seconds.
fn tools_status_sync() -> ToolsStatus {
    let mut st = tools_status_local();
    match fetch_latest_release() {
        Ok(rel) => {
            if let Some(tag) = rel.get("tag_name").and_then(|v| v.as_str()) {
                st.latest_version = Some(normalize_version(tag));
                st.update_available =
                    (is_newer(tag, &st.local_version) || !st.installed) && !st.using_local_override;
            }
        }
        Err(e) => st.error = Some(e),
    }
    st
}

/// Async so the GitHub round-trip never freezes the webview. The wizard paints first,
/// then calls this; a sync command would block paint and leave the window blank.
#[tauri::command]
async fn tools_status() -> ToolsStatus {
    tauri::async_runtime::spawn_blocking(tools_status_sync)
        .await
        .unwrap_or_else(|e| {
            let mut st = tools_status_local();
            st.error = Some(format!("status task failed: {e}"));
            st
        })
}

/// Point the app at a local xi-tools checkout (must contain src/xi).
#[tauri::command]
fn tools_set_local_path(path: String) -> Result<ToolsStatus, String> {
    let dir = PathBuf::from(path.trim());
    validate_tools_dir(&dir)?;
    fs::create_dir_all(app_data_dir()).map_err(|e| e.to_string())?;
    fs::write(tools_override_path(), dir.display().to_string()).map_err(|e| e.to_string())?;
    Ok(tools_status_local())
}

/// Clear the local-override path and go back to the downloaded install.
#[tauri::command]
fn tools_clear_local_path() -> Result<ToolsStatus, String> {
    let _ = fs::remove_file(tools_override_path());
    Ok(tools_status_local())
}

/// Folder picker pre-labelled for choosing an xi-tools checkout.
#[tauri::command]
fn pick_tools_folder(initial: Option<String>) -> Option<String> {
    let mut dialog = rfd::FileDialog::new().set_title("Select local xi-tools folder");
    if let Some(p) = initial {
        if Path::new(&p).is_dir() {
            dialog = dialog.set_directory(p);
        }
    } else if let Some(home) = env_path("USERPROFILE").or_else(|| env_path("HOME")) {
        dialog = dialog.set_directory(home);
    }
    dialog
        .pick_folder()
        .map(|p| p.to_string_lossy().into_owned())
}

fn pick_zip_asset(rel: &serde_json::Value) -> Result<(String, String), String> {
    let assets = rel
        .get("assets")
        .and_then(|a| a.as_array())
        .ok_or("release has no assets")?;
    // Prefer xi-tools-v*.zip then any .zip that isn't python.zip
    let mut best: Option<&serde_json::Value> = None;
    for a in assets {
        let name = a.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if !name.ends_with(".zip") {
            continue;
        }
        if name.eq_ignore_ascii_case("python.zip") {
            continue;
        }
        if name.starts_with("xi-tools") {
            best = Some(a);
            break;
        }
        if best.is_none() {
            best = Some(a);
        }
    }
    let a = best.ok_or("no zip asset on release")?;
    let name = a
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or("asset name missing")?
        .to_string();
    let url = a
        .get("browser_download_url")
        .and_then(|n| n.as_str())
        .ok_or("asset url missing")?
        .to_string();
    Ok((name, url))
}

fn extract_zip_progress(
    zip_path: &Path,
    dest: &Path,
    app: Option<&AppHandle>,
    stage: &str,
    label: &str,
) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let total = archive.len() as u64;
    if let Some(app) = app {
        emit_progress(app, stage, label, 0, Some(total.max(1)), "files", None);
    }
    let mut last = Instant::now() - Duration::from_millis(200);
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let outpath = match file.enclosed_name() {
            Some(p) => dest.join(p),
            None => continue,
        };
        if file.name().ends_with('/') {
            fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = outpath.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut outfile = File::create(&outpath).map_err(|e| e.to_string())?;
            copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
        }
        let done = (i as u64) + 1;
        if let Some(app) = app {
            if last.elapsed() >= Duration::from_millis(80) || done == total {
                emit_progress(app, stage, label, done, Some(total.max(1)), "files", None);
                last = Instant::now();
            }
        }
    }
    if let Some(app) = app {
        emit_progress(app, stage, label, total.max(1), Some(total.max(1)), "files", None);
    }
    Ok(())
}

/// Stream a URL to disk, emitting byte progress on `tools-progress` when `app` is set.
fn download_file_progress(
    url: &str,
    dest: &Path,
    app: Option<&AppHandle>,
    stage: &str,
    label: &str,
) -> Result<(), String> {
    let mut req = gh_client().get(url);
    if let Ok(tok) = std::env::var("GITHUB_TOKEN") {
        if !tok.trim().is_empty() {
            req = req.bearer_auth(tok.trim());
        }
    }
    let mut resp = req
        .send()
        .map_err(|e| format!("download failed ({url}): {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download HTTP {} ({url})", resp.status()));
    }
    let total = resp.content_length();
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if let Some(app) = app {
        emit_progress(app, stage, label, 0, total, "bytes", None);
    }
    let mut f = File::create(dest).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 64 * 1024];
    let mut loaded: u64 = 0;
    let mut last = Instant::now() - Duration::from_millis(200);
    loop {
        let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        loaded += n as u64;
        if let Some(app) = app {
            let finished = total.map(|t| loaded >= t).unwrap_or(false);
            if last.elapsed() >= Duration::from_millis(100) || finished {
                emit_progress(app, stage, label, loaded, total, "bytes", None);
                last = Instant::now();
            }
        }
    }
    if let Some(app) = app {
        let t = total.or(Some(loaded));
        emit_progress(app, stage, label, loaded, t, "bytes", None);
    }
    Ok(())
}

fn tools_install_or_update_sync(app: &AppHandle) -> Result<ToolsStatus, String> {
    emit_progress(
        app,
        "release",
        "Fetching latest release…",
        0,
        None,
        "none",
        None,
    );
    emit_log(app, "Fetching latest release from github.com/vekien/xi-tools …");
    let rel = fetch_latest_release()?;
    let tag = rel
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or("release tag missing")?
        .to_string();
    let (_name, url) = pick_zip_asset(&rel)?;

    let dir = xi_tools_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Wipe package sources so removed files don't linger (keep user .env).
    for wipe in ["src", "docs", "misc", "schema"] {
        let p = dir.join(wipe);
        if p.exists() {
            let _ = fs::remove_dir_all(&p);
        }
    }

    let tmp = app_data_dir().join("download.zip");
    emit_log(app, format!("Downloading xi-tools {tag} …"));
    download_file_progress(
        &url,
        &tmp,
        Some(app),
        "download-tools",
        "Downloading xi-tools…",
    )?;
    emit_log(app, "Download complete. Extracting…");

    extract_zip_progress(
        &tmp,
        &dir,
        Some(app),
        "extract-tools",
        "Extracting xi-tools…",
    )?;
    let _ = fs::remove_file(&tmp);
    emit_log(app, format!("Installed xi-tools v{}", normalize_version(&tag)));

    // Optional python.zip asset bundled with the release
    if let Some(assets) = rel.get("assets").and_then(|a| a.as_array()) {
        if let Some(py) = assets.iter().find(|a| {
            a.get("name")
                .and_then(|n| n.as_str())
                .map(|n| n.eq_ignore_ascii_case("python.zip"))
                .unwrap_or(false)
        }) {
            if let Some(purl) = py.get("browser_download_url").and_then(|u| u.as_str()) {
                let pytmp = app_data_dir().join("python.zip");
                if download_file_progress(
                    purl,
                    &pytmp,
                    Some(app),
                    "download-python-bundle",
                    "Downloading bundled Python…",
                )
                .is_ok()
                {
                    let _ = extract_zip_progress(
                        &pytmp,
                        &dir,
                        Some(app),
                        "extract-python-bundle",
                        "Extracting bundled Python…",
                    );
                }
                let _ = fs::remove_file(&pytmp);
            }
        }
    }

    emit_progress(
        app,
        "finalize",
        "Finalising install…",
        1,
        Some(1),
        "none",
        None,
    );
    fs::write(version_path(), normalize_version(&tag)).map_err(|e| e.to_string())?;

    // Ensure .env exists from sample
    let env = dir.join(".env");
    if !env.exists() {
        let sample = dir.join(".env.sample");
        if sample.exists() {
            let _ = fs::copy(sample, &env);
        } else {
            let _ = File::create(&env).and_then(|mut f| writeln!(f, "# xi-tools env"));
        }
    }

    // Local only — we just fetched the release; no need to hit GitHub again.
    let mut st = tools_status_local();
    st.latest_version = Some(normalize_version(&tag));
    st.local_version = normalize_version(&tag);
    st.installed = true;
    Ok(st)
}

#[tauri::command]
async fn tools_install_or_update(app: AppHandle) -> Result<ToolsStatus, String> {
    tauri::async_runtime::spawn_blocking(move || tools_install_or_update_sync(&app))
        .await
        .map_err(|e| format!("install task failed: {e}"))?
}

fn port_open(host: &str, port: u16) -> bool {
    use std::net::TcpStream;
    TcpStream::connect_timeout(
        &format!("{host}:{port}").parse().unwrap(),
        Duration::from_millis(250),
    )
    .is_ok()
}

/// True for the fake `WindowsApps\python*.exe` Store aliases that print
/// "Python was not found" and exit 9009 — never use those.
fn is_windows_store_stub(p: &Path) -> bool {
    let s = p.to_string_lossy().to_ascii_lowercase();
    s.contains(r"\windowsapps\python") || s.contains("/windowsapps/python")
}

fn is_real_python(p: &Path) -> bool {
    p.is_file() && !is_windows_store_stub(p)
}

/// App-managed embeddable Python (auto-downloaded from python.org).
fn embed_python_dir() -> PathBuf {
    app_data_dir().join("python")
}

fn embed_python_exe() -> PathBuf {
    embed_python_dir().join(if cfg!(windows) {
        "python.exe"
    } else {
        "python"
    })
}

/// Pinned Windows embeddable build (amd64). Bump both when upgrading.
const EMBED_PY_VERSION: &str = "3.12.8";
const EMBED_PY_URL: &str =
    "https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip";

/// Locate a usable Python. Never returns Windows Store stubs.
fn find_python(tools: &Path) -> Option<PathBuf> {
    // 1) App-managed embeddable install
    let embed = embed_python_exe();
    if is_real_python(&embed) {
        return Some(embed);
    }

    // 2) Bundled next to xi-tools (release zip / local checkout)
    const REL: &[&[&str]] = &[
        &["python", "python.exe"],
        &["python", "python", "python.exe"],
        &["runtime", "python.exe"],
        &["python.exe"],
        &["python", "python"],
        &["python"],
    ];
    for parts in REL {
        let mut p = tools.to_path_buf();
        for part in *parts {
            p.push(part);
        }
        if is_real_python(&p) {
            return Some(p);
        }
    }

    // 3) Windows `py -3` launcher
    if let Some(py) = which("py.exe").or_else(|| which("py")) {
        if is_real_python(&py) {
            return Some(py);
        }
    }

    // 4) PATH (Store stubs filtered out)
    for name in ["python3.exe", "python.exe", "python3", "python"] {
        if let Some(p) = which(name) {
            if is_real_python(&p) {
                return Some(p);
            }
        }
    }
    None
}

fn python_can_import_xi_deps(py: &Path) -> bool {
    let mut cmd = Command::new(py);
    // py launcher needs -3
    let name = py
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name == "py.exe" || name == "py" {
        cmd.arg("-3");
    }
    cmd.args(["-c", "import click, PIL, numpy"]);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn find_pth_file(dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for ent in entries.flatten() {
        let p = ent.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with("python") && name.ends_with("._pth") {
            return Some(p);
        }
    }
    None
}

fn enable_embed_site(dir: &Path) -> Result<(), String> {
    // python3xx._pth must allow site-packages (uncomment `import site`).
    let Some(p) = find_pth_file(dir) else {
        return Ok(());
    };
    let text = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    let mut changed = false;
    for line in &mut lines {
        let t = line.trim();
        if t == "#import site" || t == "# import site" {
            *line = "import site".into();
            changed = true;
        }
    }
    if !lines.iter().any(|l| l.trim() == "import site") {
        lines.push("import site".into());
        changed = true;
    }
    let sp = "Lib\\site-packages".to_string();
    if !lines.iter().any(|l| l.trim() == sp) {
        lines.push(sp);
        changed = true;
    }
    if changed {
        fs::write(&p, lines.join("\n") + "\n").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Embeddable Python **ignores PYTHONPATH** when a `._pth` file is present.
/// Inject the xi-tools `src` directory into that file so `import xi` works.
fn inject_tools_src_into_python(py_exe: &Path, tools_src: &Path) -> Result<(), String> {
    let Some(dir) = py_exe.parent() else {
        return Ok(());
    };
    let Some(pth) = find_pth_file(dir) else {
        // No ._pth → PYTHONPATH env var works fine.
        return Ok(());
    };
    let src = tools_src
        .canonicalize()
        .unwrap_or_else(|_| tools_src.to_path_buf());
    let src_s = src.display().to_string();

    let text = fs::read_to_string(&pth).map_err(|e| e.to_string())?;
    let mut lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();

    // Drop previous editor-managed entries (marker comment + following path).
    let mut cleaned = Vec::with_capacity(lines.len());
    let mut skip_next = false;
    for line in lines.drain(..) {
        if skip_next {
            skip_next = false;
            continue;
        }
        if line.trim() == "# xi-zone-editor-tools-src" {
            skip_next = true;
            continue;
        }
        cleaned.push(line);
    }
    lines = cleaned;

    // Insert before `import site` so site still runs last.
    let entry = vec![
        "# xi-zone-editor-tools-src".to_string(),
        src_s,
    ];
    if let Some(pos) = lines.iter().position(|l| l.trim() == "import site") {
        for (i, e) in entry.into_iter().enumerate() {
            lines.insert(pos + i, e);
        }
    } else {
        lines.extend(entry);
    }
    fs::write(&pth, lines.join("\n") + "\n").map_err(|e| e.to_string())?;
    Ok(())
}

/// Run a Python command, streaming stdout/stderr into the splash CLI log when `app` is set.
fn run_py(
    py: &Path,
    args: &[&str],
    cwd: Option<&Path>,
    app: Option<&AppHandle>,
) -> Result<(), String> {
    let mut cmd = Command::new(py);
    let name = py
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name == "py.exe" || name == "py" {
        cmd.arg("-3");
    }
    cmd.args(args);
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Line-buffer pip / get-pip so the splash log updates live.
        .env("PYTHONUNBUFFERED", "1")
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        .env("PIP_PROGRESS_BAR", "off");

    if let Some(app) = app {
        let shown: String = {
            let mut parts = vec![py.display().to_string()];
            parts.extend(args.iter().map(|a| (*a).to_string()));
            format!("$ {}", parts.join(" "))
        };
        emit_log(app, shown);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to run {}: {e}", py.display()))?;

    let out_h = child
        .stdout
        .take()
        .map(|r| pump_log_pipe(app.cloned(), r));
    let err_h = child
        .stderr
        .take()
        .map(|r| pump_log_pipe(app.cloned(), r));

    let status = child
        .wait()
        .map_err(|e| format!("failed waiting on {}: {e}", py.display()))?;
    if let Some(h) = out_h {
        let _ = h.join();
    }
    if let Some(h) = err_h {
        let _ = h.join();
    }

    if status.success() {
        return Ok(());
    }
    Err(format!("{} failed ({status})", py.display()))
}

/// Ensure a real Python exists (download embeddable from python.org if needed)
/// and that xi-tools requirements are importable.
fn ensure_python_runtime(tools: &Path, app: Option<&AppHandle>) -> Result<PathBuf, String> {
    // Already good?
    if let Some(py) = find_python(tools) {
        if python_can_import_xi_deps(&py) {
            return Ok(py);
        }
        // Have python but missing deps — try pip install into that env when it's our embed.
        if py.starts_with(embed_python_dir()) || py.starts_with(tools.join("python")) {
            install_xi_requirements(&py, tools, app)?;
            if python_can_import_xi_deps(&py) {
                return Ok(py);
            }
        } else if python_can_import_xi_deps(&py) {
            return Ok(py);
        } else {
            // System python without deps: still try pip install --user is messy;
            // prefer ensuring embed instead.
        }
    }

    #[cfg(not(windows))]
    {
        return Err(
            "No Python 3 with xi-tools dependencies found. Install Python 3.11+ and:\n  pip install -r requirements.txt"
                .into(),
        );
    }

    #[cfg(windows)]
    {
        let dir = embed_python_dir();
        let exe = embed_python_exe();
        let marker = dir.join(format!(".embed-{EMBED_PY_VERSION}"));

        if !is_real_python(&exe) || !marker.is_file() {
            fs::create_dir_all(app_data_dir()).map_err(|e| e.to_string())?;
            // Fresh extract
            if dir.exists() {
                let _ = fs::remove_dir_all(&dir);
            }
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

            let zip_path = app_data_dir().join("python-embed.zip");
            download_file_progress(
                EMBED_PY_URL,
                &zip_path,
                app,
                "download-python",
                "Downloading Python 3.12…",
            )?;
            extract_zip_progress(
                &zip_path,
                &dir,
                app,
                "extract-python",
                "Extracting Python…",
            )?;
            let _ = fs::remove_file(&zip_path);
            enable_embed_site(&dir)?;

            // Bootstrap pip
            let get_pip = dir.join("get-pip.py");
            download_file_progress(
                "https://bootstrap.pypa.io/get-pip.py",
                &get_pip,
                app,
                "download-pip",
                "Downloading pip…",
            )?;
            if let Some(app) = app {
                emit_progress(
                    app,
                    "setup-pip",
                    "Installing pip…",
                    0,
                    None,
                    "none",
                    Some("This usually takes a few seconds".into()),
                );
            }
            run_py(
                &exe,
                &[get_pip.to_str().unwrap_or("get-pip.py")],
                Some(&dir),
                app,
            )?;
            let _ = fs::remove_file(&get_pip);
            if let Some(app) = app {
                emit_progress(app, "setup-pip", "Installing pip…", 1, Some(1), "none", None);
            }

            fs::write(&marker, EMBED_PY_VERSION).map_err(|e| e.to_string())?;
        } else {
            let _ = enable_embed_site(&dir);
        }

        install_xi_requirements(&exe, tools, app)?;
        if !python_can_import_xi_deps(&exe) {
            return Err(format!(
                "Embedded Python is installed at {} but xi-tools dependencies failed to import.\n\
                 See pip output above / retry.",
                exe.display()
            ));
        }
        Ok(exe)
    }
}

fn install_xi_requirements(
    py: &Path,
    tools: &Path,
    app: Option<&AppHandle>,
) -> Result<(), String> {
    if let Some(app) = app {
        emit_progress(
            app,
            "install-deps",
            "Installing Python packages…",
            0,
            None,
            "none",
            Some("pip install — first run can take a minute".into()),
        );
        emit_log(app, "Installing Python packages (pip)…");
    }
    let req = tools.join("requirements.txt");
    if !req.is_file() {
        // Minimal set if requirements missing from an old zip
        run_py(
            py,
            &[
                "-m",
                "pip",
                "install",
                "--upgrade",
                "pip",
                "click>=8.0",
                "prompt_toolkit>=3.0",
                "pefile",
                "capstone",
                "pillow>=12.2.0",
                "pymysql>=1.1",
                "numpy>=1.26",
            ],
            None,
            app,
        )?;
        if let Some(app) = app {
            emit_progress(
                app,
                "install-deps",
                "Installing Python packages…",
                1,
                Some(1),
                "none",
                None,
            );
        }
        return Ok(());
    }
    run_py(
        py,
        &["-m", "pip", "install", "--upgrade", "pip"],
        None,
        app,
    )?;
    run_py(
        py,
        &[
            "-m",
            "pip",
            "install",
            "-r",
            req.to_str().ok_or("requirements path")?,
        ],
        None,
        app,
    )?;
    if let Some(app) = app {
        emit_progress(
            app,
            "install-deps",
            "Installing Python packages…",
            1,
            Some(1),
            "none",
            None,
        );
    }
    Ok(())
}

fn explain_exit_code(code: Option<i32>, exe: &Path, detail: &str) -> String {
    let code = code.unwrap_or(-1);
    let mut msg = format!("Bridge failed to start (exit code {code}).\n");
    // Windows cmd ERROR_FILE_NOT_FOUND — almost always "python/xi not found".
    if code == 9009 {
        msg.push_str(
            "\nWindows exit 9009 means the program was not found.\n\
             Install Python 3.11+ and ensure `python` is on PATH, or ship\n\
             python.zip with the xi-tools release, then retry Download.\n",
        );
    } else if code == 1 || code == 2 {
        msg.push_str("\nThe bridge process started but exited with an error.\n");
    }
    msg.push_str(&format!("\nCommand: {}\n", exe.display()));
    if !detail.trim().is_empty() {
        msg.push_str("\n--- output ---\n");
        msg.push_str(detail.trim());
        msg.push('\n');
    }
    msg.push_str(&format!(
        "\nTools folder: {}\n\
         Expected package: {}\\src\\xi\n",
        xi_tools_dir().display(),
        xi_tools_dir().display()
    ));
    msg
}

fn resolve_bridge_command(
    tools: &Path,
    app: Option<&AppHandle>,
) -> Result<(PathBuf, Vec<String>, PathBuf), String> {
    let src = tools.join("src");
    let pkg = src.join("xi");
    if !pkg.is_dir() {
        return Err(format!(
            "xi-tools package missing at {}\\src\\xi\n\
             Re-run Download / Update from the XI Tools setup screen.",
            tools.display()
        ));
    }

    // System `xi` CLI if present (optional fast path)
    if let Some(xi) = which("xi")
        .or_else(|| which("xi.cmd"))
        .or_else(|| which("xi.exe"))
        .filter(|p| !is_windows_store_stub(p))
    {
        return Ok((
            xi,
            vec![
                "bridge".into(),
                "--host".into(),
                BRIDGE_HOST.into(),
                "--port".into(),
                BRIDGE_PORT.to_string(),
                "--idle-secs".into(),
                BRIDGE_IDLE_SECS.to_string(),
            ],
            tools.to_path_buf(),
        ));
    }

    // Real Python: system, local, or auto-downloaded embeddable from python.org
    let py = ensure_python_runtime(tools, app)?;
    let mut args: Vec<String> = Vec::new();
    let name = py
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name == "py.exe" || name == "py" {
        args.push("-3".into());
    }
    args.extend([
        "-u".into(),
        "-m".into(),
        "xi.xi_cli".into(),
        "bridge".into(),
        "--host".into(),
        BRIDGE_HOST.into(),
        "--port".into(),
        BRIDGE_PORT.to_string(),
        "--idle-secs".into(),
        BRIDGE_IDLE_SECS.to_string(),
    ]);
    Ok((py, args, tools.to_path_buf()))
}

fn bridge_start_sync(app: &AppHandle) -> Result<String, String> {
    if port_open(BRIDGE_HOST, BRIDGE_PORT) {
        return Ok(format!("ws://{BRIDGE_HOST}:{BRIDGE_PORT}/ws"));
    }
    let tools = xi_tools_dir();
    emit_progress(
        app,
        "python",
        "Preparing Python runtime…",
        0,
        None,
        "none",
        None,
    );
    let (exe, args, cwd) = resolve_bridge_command(&tools, Some(app))?;
    let src = tools.join("src");
    let env_file = tools.join(".env");
    let log_path = app_data_dir().join("bridge-last.log");
    fs::create_dir_all(app_data_dir()).map_err(|e| e.to_string())?;

    // Critical: embeddable Python ignores PYTHONPATH when python*._pth exists.
    // Put tools/src on sys.path via that file so `import xi` works.
    if src.is_dir() {
        inject_tools_src_into_python(&exe, &src)?;
    }

    emit_progress(
        app,
        "start-bridge",
        "Starting the bridge…",
        0,
        None,
        "none",
        None,
    );
    emit_log(
        app,
        format!("Starting bridge: {} {}", exe.display(), args.join(" ")),
    );

    // Header so the log is self-explanatory if the user opens it.
    {
        let mut hdr = File::create(&log_path).map_err(|e| e.to_string())?;
        let _ = writeln!(
            hdr,
            "xi-zone-editor bridge launch\nexe: {}\nargs: {:?}\ncwd: {}\ntools_src: {}\n---\n",
            exe.display(),
            args,
            cwd.display(),
            src.display()
        );
    }

    let mut cmd = Command::new(&exe);
    cmd.args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(
            File::options()
                .append(true)
                .create(true)
                .open(&log_path)
                .map_err(|e| e.to_string())?,
        ))
        .stderr(Stdio::from(
            File::options()
                .append(true)
                .create(true)
                .open(&log_path)
                .map_err(|e| e.to_string())?,
        ));
    if src.is_dir() {
        // Harmless for embeddable (._pth wins); required for normal CPython.
        cmd.env("PYTHONPATH", src.display().to_string());
    }
    if env_file.is_file() {
        cmd.env("XI_ENV_FILE", &env_file);
        cmd.env("CEXI_ENV_FILE", &env_file);
    }
    // Prefer install root for texconv/misc; don't clobber a user XI_TOOLS_DIR from .env
    // (setdefault in Python won't override what we set here).
    let env_map = {
        let mut m = std::collections::HashMap::<String, String>::new();
        if let Ok(text) = fs::read_to_string(&env_file) {
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') || !line.contains('=') {
                    continue;
                }
                let mut parts = line.splitn(2, '=');
                if let (Some(k), Some(v)) = (parts.next(), parts.next()) {
                    m.insert(k.trim().to_string(), v.trim().trim_matches('"').to_string());
                }
            }
        }
        m
    };
    if !env_map.contains_key("XI_TOOLS_DIR") {
        cmd.env("XI_TOOLS_DIR", tools.display().to_string());
    }
    // Exports (icons/audio) often live on the dev checkout even when the package
    // is under AppData — point at tools/exports or a sibling D:\xi-tools\exports.
    if !env_map.contains_key("XI_EXPORTS_DIR") {
        let local_exp = tools.join("exports");
        if local_exp.is_dir() {
            cmd.env("XI_EXPORTS_DIR", local_exp.display().to_string());
        } else {
            let dev_exp = PathBuf::from(r"D:\xi-tools\exports");
            if dev_exp.is_dir() {
                cmd.env("XI_EXPORTS_DIR", dev_exp.display().to_string());
            }
        }
    }
    cmd.env("PYTHONUNBUFFERED", "1");
    cmd.env("PYTHONIOENCODING", "utf-8");
    if let Ok(ffxi) = std::env::var("FFXI_DIR") {
        cmd.env("FFXI_DIR", ffxi);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to launch bridge process.\n\n{e}\n\n{}",
            explain_exit_code(None, &exe, "")
        )
    })?;
    job::attach(&child);

    // Wait until port opens (or process dies).
    for _ in 0..80 {
        if port_open(BRIDGE_HOST, BRIDGE_PORT) {
            *BRIDGE_CHILD.lock().unwrap() = Some(child);
            return Ok(format!("ws://{BRIDGE_HOST}:{BRIDGE_PORT}/ws"));
        }
        if let Ok(Some(status)) = child.try_wait() {
            let detail = fs::read_to_string(&log_path).unwrap_or_default();
            return Err(explain_exit_code(status.code(), &exe, &detail));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let _ = child.kill();
    let detail = fs::read_to_string(&log_path).unwrap_or_default();
    Err(format!(
        "Bridge did not open port {BRIDGE_PORT} in time.\n\nCommand: {}\n\n--- log ---\n{}",
        exe.display(),
        detail.trim()
    ))
}

#[tauri::command]
async fn bridge_start(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || bridge_start_sync(&app))
        .await
        .map_err(|e| format!("bridge task failed: {e}"))?
}

#[tauri::command]
fn bridge_stop() -> Result<(), String> {
    if let Some(mut child) = BRIDGE_CHILD.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    // Also kill anything still listening (orphan from prior crash).
    #[cfg(windows)]
    {
        let _ = Command::new("cmd")
            .args([
                "/C",
                &format!(
                    "for /f \"tokens=5\" %a in ('netstat -ano ^| findstr :{BRIDGE_PORT} ^| findstr LISTENING') do taskkill /F /PID %a"
                ),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    Ok(())
}

#[tauri::command]
fn bridge_url() -> String {
    format!("ws://{BRIDGE_HOST}:{BRIDGE_PORT}/ws")
}

/// Modern Explorer folder picker (rfd → IFileDialog with FOS_PICKFOLDERS on Windows):
/// address bar, left nav, search. The bridge's PowerShell fallback uses
/// FolderBrowserDialog, which renders the legacy SHBrowseForFolder tree — so the
/// frontend prefers this whenever it is running inside the desktop shell.
#[tauri::command]
fn pick_folder(initial: Option<String>, title: Option<String>) -> Option<String> {
    let mut dialog =
        rfd::FileDialog::new().set_title(title.unwrap_or_else(|| "Select folder".into()));
    if let Some(p) = initial {
        // Walk up to the nearest folder that exists: a half-typed or since-deleted path
        // would otherwise drop the dialog at some arbitrary default.
        let mut probe = PathBuf::from(&p);
        while !probe.as_os_str().is_empty() && !probe.is_dir() {
            if !probe.pop() {
                break;
            }
        }
        if probe.is_dir() {
            dialog = dialog.set_directory(probe);
        }
    }
    dialog
        .pick_folder()
        .map(|p| p.to_string_lossy().into_owned())
}

// ── Desktop shortcut ─────────────────────────────────────────────────────────

const SHORTCUT_NAME: &str = "XI Zone Editor";

#[derive(Serialize)]
struct DesktopShortcut {
    /// False on non-Windows, so the wizard can hide the step rather than offer a
    /// button that always fails.
    supported: bool,
    exists: bool,
    path: String,
}

/// Run a PowerShell snippet, passing values via the environment.
///
/// Paths go in as env vars rather than being interpolated into the script text —
/// they routinely contain spaces, and quoting them into a `-Command` string is a
/// reliable way to produce a broken shortcut on someone else's machine.
#[cfg(windows)]
fn powershell(script: &str, vars: &[(&str, &str)]) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ])
    .creation_flags(CREATE_NO_WINDOW);
    for (k, v) in vars {
        cmd.env(k, v);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("Could not run PowerShell: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "PowerShell reported an error creating the shortcut.".into()
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Desktop folder via the shell API, so redirected/OneDrive profiles resolve correctly
/// (`%USERPROFILE%\Desktop` is simply wrong on those machines).
#[cfg(windows)]
fn desktop_shortcut_path() -> Result<PathBuf, String> {
    let dir = powershell("[Environment]::GetFolderPath('Desktop')", &[])?;
    if dir.is_empty() {
        return Err("Could not locate your Desktop folder.".into());
    }
    Ok(PathBuf::from(dir).join(format!("{SHORTCUT_NAME}.lnk")))
}

#[tauri::command]
fn desktop_shortcut_status() -> DesktopShortcut {
    #[cfg(windows)]
    {
        match desktop_shortcut_path() {
            Ok(p) => DesktopShortcut {
                supported: true,
                exists: p.is_file(),
                path: p.display().to_string(),
            },
            Err(_) => DesktopShortcut {
                supported: true,
                exists: false,
                path: String::new(),
            },
        }
    }
    #[cfg(not(windows))]
    {
        DesktopShortcut {
            supported: false,
            exists: false,
            path: String::new(),
        }
    }
}

#[tauri::command]
fn create_desktop_shortcut() -> Result<DesktopShortcut, String> {
    #[cfg(not(windows))]
    {
        Err("Desktop shortcuts are only supported on Windows.".into())
    }
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| format!("Could not find this app: {e}"))?;
        let dir = exe
            .parent()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        let lnk = desktop_shortcut_path()?;

        powershell(
            r#"
$sh = New-Object -ComObject WScript.Shell
$sc = $sh.CreateShortcut($env:XIZE_LNK)
$sc.TargetPath = $env:XIZE_EXE
$sc.WorkingDirectory = $env:XIZE_DIR
$sc.IconLocation = "$($env:XIZE_EXE),0"
$sc.Description = 'XI Zone Editor'
$sc.Save()
"#,
            &[
                ("XIZE_LNK", &lnk.display().to_string()),
                ("XIZE_EXE", &exe.display().to_string()),
                ("XIZE_DIR", &dir),
            ],
        )?;

        if !lnk.is_file() {
            return Err("PowerShell reported success but no shortcut appeared on the Desktop.".into());
        }
        Ok(DesktopShortcut {
            supported: true,
            exists: true,
            path: lnk.display().to_string(),
        })
    }
}

fn main() {
    load_dotenv();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            tools_status,
            tools_install_or_update,
            tools_set_local_path,
            tools_clear_local_path,
            pick_tools_folder,
            bridge_start,
            bridge_stop,
            bridge_url,
            pick_folder,
            desktop_shortcut_status,
            create_desktop_shortcut,
        ])
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let _ = bridge_stop();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building xi-zone-editor")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                let _ = bridge_stop();
            }
        });
}
