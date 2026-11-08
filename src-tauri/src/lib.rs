// The desktop shell. The app itself is the same html/js as the web version;
// js/native.js turns these commands into the window.electronAPI the app uses.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering::SeqCst},
        Mutex,
    },
    thread,
    time::{Duration, UNIX_EPOCH},
};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, RunEvent, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

const SITE: &str = "https://rquw.github.io/fabu/";

#[derive(Default)]
struct Shared {
    dirty: AtomicBool,
    quit_ok: AtomicBool,
    close_gen: AtomicU64,
    win_gen: AtomicU64,
    fullscreen: AtomicBool,
    update: Mutex<Option<Update>>,
    update_bytes: Mutex<Option<Vec<u8>>>,
    midi_started: AtomicBool,
    midi_ports: Mutex<Vec<Value>>,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn fail(e: impl std::fmt::Display) -> Value {
    json!({ "ok": false, "error": e.to_string() })
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

// same folder the electron version used, so autosave, the instrument library
// and the window position carry over
fn user_dir(app: &AppHandle) -> PathBuf {
    let base = app.path().data_dir().unwrap_or_else(|_| std::env::temp_dir());
    let d = base.join("fabu");
    let _ = fs::create_dir_all(&d);
    d
}

fn projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().document_dir().map_err(err)?.join("fabu projects");
    fs::create_dir_all(&d).map_err(err)?;
    Ok(d)
}

fn write_data(path: &Path, opts: &Value) -> Value {
    let data = opts["data"].as_str().unwrap_or("");
    let res = if opts["encoding"].as_str() == Some("base64") {
        match B64.decode(data) {
            Ok(bytes) => fs::write(path, bytes),
            Err(e) => return fail(e),
        }
    } else {
        fs::write(path, data)
    };
    match res {
        Ok(_) => json!({ "ok": true, "path": path.to_string_lossy(), "name": file_name(path) }),
        Err(e) => fail(e),
    }
}

fn read_data(path: &Path) -> Value {
    match fs::read(path) {
        Ok(bytes) => json!({
            "ok": true,
            "name": file_name(path),
            "path": path.to_string_lossy(),
            "data": B64.encode(bytes)
        }),
        Err(e) => fail(e),
    }
}

fn with_filters<R: tauri::Runtime>(mut d: FileDialogBuilder<R>, filters: &Value) -> FileDialogBuilder<R> {
    for f in filters.as_array().into_iter().flatten() {
        let name = f["name"].as_str().unwrap_or("Files");
        let exts: Vec<&str> = f["extensions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|e| e.as_str())
            .collect();
        if !exts.is_empty() {
            d = d.add_filter(name, &exts);
        }
    }
    d
}

// ---------- files ----------

#[tauri::command]
async fn save_file(app: AppHandle, window: WebviewWindow, opts: Value) -> Value {
    let name = opts["defaultName"].as_str().unwrap_or("Untitled").to_string();
    let mut d = app.dialog().file().set_parent(&window).set_file_name(name);
    if let Ok(dir) = projects_dir(&app) {
        d = d.set_directory(dir);
    }
    d = with_filters(d, &opts["filters"]);
    let Some(picked) = d.blocking_save_file() else { return json!({ "ok": false }) };
    match picked.into_path() {
        Ok(p) => write_data(&p, &opts),
        Err(_) => json!({ "ok": false }),
    }
}

#[tauri::command]
async fn open_file(app: AppHandle, window: WebviewWindow, opts: Value) -> Value {
    let mut d = app.dialog().file().set_parent(&window);
    if let Ok(dir) = projects_dir(&app) {
        d = d.set_directory(dir);
    }
    d = with_filters(d, &opts["filters"]);
    let Some(picked) = d.blocking_pick_file() else { return json!({ "ok": false }) };
    match picked.into_path() {
        Ok(p) => read_data(&p),
        Err(_) => json!({ "ok": false }),
    }
}

#[tauri::command]
fn write_file(opts: Value) -> Value {
    let Some(p) = opts["filePath"].as_str() else { return fail("no path") };
    write_data(Path::new(p), &opts)
}

#[tauri::command]
fn open_path(opts: Value) -> Value {
    let Some(p) = opts["filePath"].as_str() else { return fail("no path") };
    read_data(Path::new(p))
}

#[tauri::command]
fn get_projects_dir(app: AppHandle) -> Value {
    match projects_dir(&app) {
        Ok(d) => json!({ "ok": true, "path": d.to_string_lossy() }),
        Err(e) => fail(e),
    }
}

#[tauri::command]
fn save_to_projects(app: AppHandle, opts: Value) -> Value {
    let dir = match projects_dir(&app) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let raw = opts["name"].as_str().unwrap_or("Untitled");
    let base: String = raw.chars().filter(|c| !r#"\/:*?"<>|"#.contains(*c)).collect();
    let base = match base.trim() {
        "" => "Untitled".to_string(),
        b => b.to_string(),
    };
    let mut file = dir.join(format!("{base}.fab"));
    let mut n = 2;
    while file.exists() {
        file = dir.join(format!("{base} {n}.fab"));
        n += 1;
    }
    match fs::write(&file, opts["data"].as_str().unwrap_or("")) {
        Ok(_) => json!({ "ok": true, "path": file.to_string_lossy(), "name": file_name(&file) }),
        Err(e) => fail(e),
    }
}

#[tauri::command]
fn reveal_path(app: AppHandle, opts: Value) -> Value {
    let res = match opts["filePath"].as_str() {
        Some(p) if !p.is_empty() => tauri_plugin_opener::reveal_item_in_dir(p).map_err(err),
        _ => projects_dir(&app).and_then(|d| {
            app.opener().open_path(d.to_string_lossy(), None::<&str>).map_err(err)
        }),
    };
    match res {
        Ok(_) => json!({ "ok": true }),
        Err(e) => fail(e),
    }
}

fn read_text(path: PathBuf, with_time: bool) -> Value {
    if !path.exists() {
        return json!({ "ok": false });
    }
    match fs::read_to_string(&path) {
        Ok(data) => {
            let mut v = json!({ "ok": true, "data": data });
            if with_time {
                let at = fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                v["at"] = json!(at);
            }
            v
        }
        Err(e) => fail(e),
    }
}

#[tauri::command]
fn library_write(app: AppHandle, opts: Value) -> Value {
    match fs::write(user_dir(&app).join("instruments.json"), opts["data"].as_str().unwrap_or("")) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => fail(e),
    }
}

#[tauri::command]
fn library_read(app: AppHandle) -> Value {
    read_text(user_dir(&app).join("instruments.json"), false)
}

#[tauri::command]
fn autosave_write(app: AppHandle, opts: Value) -> Value {
    match fs::write(user_dir(&app).join("autosave.fab"), opts["data"].as_str().unwrap_or("")) {
        Ok(_) => {
            let now = std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            json!({ "ok": true, "at": now })
        }
        Err(e) => fail(e),
    }
}

#[tauri::command]
fn autosave_read(app: AppHandle) -> Value {
    read_text(user_dir(&app).join("autosave.fab"), true)
}

#[tauri::command]
fn get_languages(app: AppHandle) -> Value {
    let mut out = vec![];
    let Ok(res) = app.path().resource_dir() else { return json!(out) };
    let Ok(rd) = fs::read_dir(res.join("languages")) else { return json!(out) };
    let mut files: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path())).collect();
    files.sort();
    for p in files {
        let name = file_name(&p);
        if !name.to_lowercase().ends_with(".json") || name == "index.json" {
            continue;
        }
        if let Ok(data) = fs::read_to_string(&p).map_err(err).and_then(|s| serde_json::from_str::<Value>(&s).map_err(err)) {
            out.push(json!({ "file": name, "data": data }));
        }
    }
    json!(out)
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) {
    if url.starts_with("https://") || url.starts_with("http://") {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

// ---------- the old electron app's settings ----------

// Electron kept localStorage (settings, login, recent files) in a leveldb
// folder. Read it once so nobody starts over after switching.
#[tauri::command]
fn legacy_storage(app: AppHandle) -> Value {
    let src = user_dir(&app).join("Local Storage").join("leveldb");
    if !src.is_dir() {
        return json!({});
    }
    let tmp = std::env::temp_dir().join(format!("fabu-oldstorage-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    if fs::create_dir_all(&tmp).is_err() {
        return json!({});
    }
    for e in fs::read_dir(&src).into_iter().flatten().flatten() {
        let name = e.file_name();
        if name == "LOCK" {
            continue;
        }
        let _ = fs::copy(e.path(), tmp.join(name));
    }
    let out = read_local_storage(&tmp).unwrap_or_default();
    let _ = fs::remove_dir_all(&tmp);
    json!(out)
}

fn decode_chromium_str(b: &[u8]) -> Option<String> {
    let (kind, rest) = b.split_first()?;
    match kind {
        1 => Some(rest.iter().map(|&c| c as char).collect()), // latin-1
        0 => {
            let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            String::from_utf16(&units).ok()
        }
        _ => None,
    }
}

fn read_local_storage(dir: &Path) -> Option<HashMap<String, String>> {
    use rusty_leveldb::{LdbIterator, Options, DB};
    let mut opt = Options::default();
    opt.create_if_missing = false;
    let mut db = DB::open(dir, opt).ok()?;
    let mut it = db.new_iter().ok()?;
    let prefix = b"_file://\x00";
    let mut out = HashMap::new();
    while let Some((k, v)) = it.next() {
        if !k.starts_with(prefix) {
            continue;
        }
        if let (Some(key), Some(val)) = (decode_chromium_str(&k[prefix.len()..]), decode_chromium_str(&v)) {
            out.insert(key, val);
        }
    }
    Some(out)
}

// ---------- closing ----------

fn begin_quit(app: &AppHandle) {
    let st = app.state::<Shared>();
    if st.quit_ok.swap(true, SeqCst) {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        save_window_state(&w);
        let _ = w.hide();
    }
    app.exit(0);
}

fn request_close(app: &AppHandle) {
    let st = app.state::<Shared>();
    if !st.dirty.load(SeqCst) {
        begin_quit(app);
        return;
    }
    let _ = app.emit("confirm-close", ());
    // the page answers right away, or cancels this timer when it shows the prompt
    let gen = st.close_gen.fetch_add(1, SeqCst) + 1;
    let a = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(3));
        let st = a.state::<Shared>();
        if st.close_gen.load(SeqCst) == gen && !st.quit_ok.load(SeqCst) {
            begin_quit(&a);
        }
    });
}

#[tauri::command]
fn set_dirty(app: AppHandle, dirty: bool) {
    app.state::<Shared>().dirty.store(dirty, SeqCst);
}

#[tauri::command]
fn close_confirmed(app: AppHandle) {
    begin_quit(&app);
}

#[tauri::command]
fn close_cancelled(app: AppHandle) {
    app.state::<Shared>().close_gen.fetch_add(1, SeqCst);
}

// ---------- window ----------

#[derive(Serialize, Deserialize, Default, Clone)]
struct WinState {
    x: Option<f64>,
    y: Option<f64>,
    width: f64,
    height: f64,
    #[serde(default)]
    maximized: bool,
    #[serde(default)]
    fullscreen: bool,
}

fn win_state_path(app: &AppHandle) -> PathBuf {
    user_dir(app).join("window-state.json")
}

fn read_win_state(app: &AppHandle) -> Option<WinState> {
    let s: WinState = serde_json::from_str(&fs::read_to_string(win_state_path(app)).ok()?).ok()?;
    (s.width > 0.0 && s.height > 0.0).then_some(s)
}

fn save_window_state(w: &WebviewWindow) {
    let app = w.app_handle();
    let maximized = w.is_maximized().unwrap_or(false);
    let fullscreen = w.is_fullscreen().unwrap_or(false);
    if w.is_minimized().unwrap_or(false) {
        return;
    }
    let mut s = read_win_state(app).unwrap_or(WinState { width: 1440.0, height: 900.0, ..Default::default() });
    // keep the last normal size while maximized, so un-maximizing next time still works
    if !maximized && !fullscreen {
        let scale = w.scale_factor().unwrap_or(1.0);
        if let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) {
            let p = pos.to_logical::<f64>(scale);
            let sz = size.to_logical::<f64>(scale);
            s.x = Some(p.x);
            s.y = Some(p.y);
            s.width = sz.width;
            s.height = sz.height;
        }
    }
    s.maximized = maximized;
    s.fullscreen = fullscreen;
    if let Ok(txt) = serde_json::to_string(&s) {
        let _ = fs::write(win_state_path(app), txt);
    }
}

fn on_screen(app: &AppHandle, s: &WinState) -> bool {
    let (Some(x), Some(y)) = (s.x, s.y) else { return false };
    let Ok(mons) = app.available_monitors() else { return false };
    mons.iter().any(|m| {
        let sc = m.scale_factor();
        let p = m.position().to_logical::<f64>(sc);
        let z = m.size().to_logical::<f64>(sc);
        x < p.x + z.width && x + s.width > p.x && y < p.y + z.height && y + s.height > p.y
    })
}

fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let saved = read_win_state(app);
    let first_run = saved.is_none();
    let s = saved.unwrap_or(WinState { width: 1440.0, height: 900.0, ..Default::default() });

    let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("fabu")
        .inner_size(s.width, s.height)
        .min_inner_size(980.0, 620.0)
        .background_color(tauri::window::Color(17, 18, 20, 255))
        .visible(false);
    b = if on_screen(app, &s) { b.position(s.x.unwrap(), s.y.unwrap()) } else { b.center() };
    #[cfg(target_os = "macos")]
    {
        b = b
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(LogicalPosition::new(16.0, 20.0));
    }
    let w = b.build()?;

    if s.maximized {
        let _ = w.maximize();
    } else if first_run {
        // first launch: fill the screen, with a small margin
        if let Ok(Some(m)) = w.primary_monitor() {
            let sc = m.scale_factor();
            let a = m.work_area();
            let p = a.position.to_logical::<f64>(sc);
            let z = a.size.to_logical::<f64>(sc);
            let _ = w.set_position(LogicalPosition::new(p.x + 12.0, p.y + 12.0));
            let _ = w.set_size(LogicalSize::new(z.width - 24.0, z.height - 24.0));
        }
    }
    if s.fullscreen {
        let _ = w.set_fullscreen(true);
    }
    let _ = w.show();
    let _ = w.set_focus();
    Ok(())
}

#[tauri::command]
fn is_fullscreen(window: WebviewWindow) -> bool {
    window.is_fullscreen().unwrap_or(false)
}

#[tauri::command]
fn start_drag(window: WebviewWindow) {
    let _ = window.start_dragging();
}

#[tauri::command]
fn toggle_maximize(window: WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

// ---------- updates ----------

#[tauri::command]
fn get_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

async fn find_update(app: &AppHandle) -> Result<Option<Update>, String> {
    let up = app.updater().map_err(err)?.check().await.map_err(err)?;
    if let Some(u) = &up {
        *app.state::<Shared>().update.lock().unwrap() = Some(u.clone());
    }
    Ok(up)
}

#[tauri::command]
async fn check_updates(app: AppHandle) -> Value {
    let version = app.package_info().version.to_string();
    if cfg!(debug_assertions) {
        return json!({ "status": "dev", "version": version });
    }
    match find_update(&app).await {
        Ok(Some(u)) => json!({ "status": "update", "version": u.version }),
        Ok(None) => json!({ "status": "latest", "version": version }),
        Err(_) => json!({ "status": "error", "version": version }),
    }
}

fn update_failed(app: &AppHandle, e: impl std::fmt::Display) {
    let _ = app.emit("update-error", e.to_string());
    let _ = app.opener().open_url(SITE, None::<&str>); // the site always works
}

#[tauri::command]
async fn install_update(app: AppHandle) {
    let up = app.state::<Shared>().update.lock().unwrap().clone();
    let Some(up) = up else {
        let _ = app.opener().open_url(SITE, None::<&str>);
        return;
    };
    let a = app.clone();
    let mut got: u64 = 0;
    let mut last: i64 = -1;
    let res = up
        .download(
            move |chunk, total| {
                got += chunk as u64;
                if let Some(t) = total.filter(|t| *t > 0) {
                    let pct = (got * 100 / t).min(100) as i64;
                    if pct != last {
                        last = pct;
                        let _ = a.emit("update-progress", pct);
                    }
                }
            },
            || {},
        )
        .await;
    match res {
        Ok(bytes) => {
            // windows: keep a copy of the installer in Downloads in case the restart goes wrong
            let mut backup: Option<String> = None;
            if cfg!(windows) {
                if let Ok(dl) = app.path().download_dir() {
                    let p = dl.join(format!("fabu-{}-installer.exe", up.version));
                    if fs::write(&p, &bytes).is_ok() {
                        backup = Some(p.to_string_lossy().into_owned());
                    }
                }
            }
            *app.state::<Shared>().update_bytes.lock().unwrap() = Some(bytes);
            let _ = app.emit("update-downloaded", backup);
        }
        Err(e) => update_failed(&app, e),
    }
}

#[tauri::command]
fn restart_now(app: AppHandle) {
    let st = app.state::<Shared>();
    let bytes = st.update_bytes.lock().unwrap().take();
    let up = st.update.lock().unwrap().clone();
    let (Some(bytes), Some(up)) = (bytes, up) else { return };
    let _ = app.emit("update-restarting", ()); // the page does a last autosave
    let a = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(500));
        let st = a.state::<Shared>();
        st.quit_ok.store(true, SeqCst);
        if let Some(w) = a.get_webview_window("main") {
            save_window_state(&w);
        }
        // on windows this starts the installer and exits by itself
        match up.install(bytes) {
            Ok(_) => a.restart(),
            Err(e) => {
                st.quit_ok.store(false, SeqCst);
                update_failed(&a, e);
            }
        }
    });
}

fn watch_for_updates(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            if let Ok(Some(u)) = find_update(&app).await {
                let _ = app.emit("update-ready", u.version.clone());
            }
            tokio::time::sleep(Duration::from_secs(15 * 60)).await;
        }
    });
}

// leftovers from the old electron updater
fn clean_update_leftovers() {
    for e in fs::read_dir(std::env::temp_dir()).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if n.starts_with("fabu-update-") || n.starts_with("fabu-old-") || n.starts_with("fabu-oldstorage-") {
            let p = e.path();
            let _ = if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
        }
    }
}

// ---------- MIDI ----------
// WebKit (the mac webview) has no Web MIDI, so read the keyboard here and
// send the bytes to the page. Used on windows too so both behave the same.

#[tauri::command]
fn midi_ports(app: AppHandle) -> Value {
    start_midi(&app);
    json!(*app.state::<Shared>().midi_ports.lock().unwrap())
}

fn start_midi(app: &AppHandle) {
    if app.state::<Shared>().midi_started.swap(true, SeqCst) {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        use midir::{Ignore, MidiInput, MidiInputConnection};
        let Ok(scanner) = MidiInput::new("fabu") else { return };
        let mut conns: HashMap<String, MidiInputConnection<()>> = HashMap::new();
        let mut last_ids: Vec<String> = vec![];
        loop {
            let mut seen: HashMap<String, usize> = HashMap::new();
            let mut found = vec![];
            for p in scanner.ports() {
                let name = scanner.port_name(&p).unwrap_or_else(|_| "MIDI device".into());
                let n = seen.entry(name.clone()).or_insert(0);
                *n += 1;
                let id = if *n > 1 { format!("{name} #{n}") } else { name.clone() };
                found.push((id, name, p));
            }
            let ids: HashSet<&String> = found.iter().map(|f| &f.0).collect();
            conns.retain(|k, _| ids.contains(k)); // unplugged: dropping closes it
            for (id, _, port) in &found {
                if conns.contains_key(id) {
                    continue;
                }
                let Ok(mut input) = MidiInput::new("fabu") else { continue };
                input.ignore(Ignore::All);
                let a = app.clone();
                let pid = id.clone();
                if let Ok(c) = input.connect(
                    port,
                    "fabu-in",
                    move |_, msg, _| {
                        let _ = a.emit("midi-msg", json!({ "id": pid, "data": msg }));
                    },
                    (),
                ) {
                    conns.insert(id.clone(), c);
                }
            }
            let list: Vec<Value> = found
                .iter()
                .filter(|f| conns.contains_key(&f.0))
                .map(|f| json!({ "id": f.0, "name": f.1 }))
                .collect();
            let now_ids: Vec<String> = list.iter().map(|v| v["id"].as_str().unwrap_or("").to_string()).collect();
            if now_ids != last_ids {
                last_ids = now_ids;
                *app.state::<Shared>().midi_ports.lock().unwrap() = list.clone();
                let _ = app.emit("midi-ports", list);
            }
            thread::sleep(Duration::from_secs(2));
        }
    });
}

// ---------- start ----------

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Shared::default())
        .invoke_handler(tauri::generate_handler![
            save_file,
            open_file,
            write_file,
            open_path,
            get_projects_dir,
            save_to_projects,
            reveal_path,
            library_write,
            library_read,
            autosave_write,
            autosave_read,
            get_languages,
            open_external,
            legacy_storage,
            set_dirty,
            close_confirmed,
            close_cancelled,
            is_fullscreen,
            start_drag,
            toggle_maximize,
            get_version,
            check_updates,
            install_update,
            restart_now,
            midi_ports
        ])
        .setup(|app| {
            let h = app.handle().clone();
            create_main_window(&h)?;
            clean_update_leftovers();
            watch_for_updates(h.clone());
            // write the window position at most twice a second while it moves
            thread::spawn(move || {
                let mut seen = 0;
                loop {
                    thread::sleep(Duration::from_millis(500));
                    let g = h.state::<Shared>().win_gen.load(SeqCst);
                    if g != seen {
                        seen = g;
                        if let Some(w) = h.get_webview_window("main") {
                            save_window_state(&w);
                        }
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|w, ev| {
            let app = w.app_handle();
            let st = app.state::<Shared>();
            match ev {
                WindowEvent::CloseRequested { api, .. } => {
                    if !st.quit_ok.load(SeqCst) {
                        api.prevent_close();
                        request_close(app);
                    }
                }
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    st.win_gen.fetch_add(1, SeqCst);
                    let fs_now = w.is_fullscreen().unwrap_or(false);
                    if st.fullscreen.swap(fs_now, SeqCst) != fs_now {
                        let _ = app.emit("fullscreen-changed", fs_now);
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("could not start fabu");

    app.run(|app, ev| {
        if let RunEvent::ExitRequested { api, code, .. } = ev {
            // cmd+q and friends go through the same unsaved-changes check
            if code.is_none() && !app.state::<Shared>().quit_ok.load(SeqCst) {
                api.prevent_exit();
                request_close(app);
            }
        }
    });
}
