use std::path::PathBuf;

use tauri::{Manager, Runtime, Window};
use tauri_plugin_fs::FsExt;

#[cfg(not(target_os = "macos"))]
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn abs_pick_export_path<R: Runtime>(
    window: Window<R>,
    title: String,
    file_name: Option<String>,
) -> Result<Option<String>, String> {
    let label = window.label();
    if label != "main" && !label.starts_with("editor-") {
        return Err("Open the editor to choose where to export".into());
    }

    let extension = match file_name.as_deref() {
        Some(name) if name.ends_with(".png") => Some("png"),
        Some(name) if name.ends_with(".mp4") => Some("mp4"),
        Some(_) => return Err("Choose a PNG or MP4 filename".into()),
        None => None,
    };
    let picker_window = window.clone();
    let directory = file_name.is_none();
    let Some(path) = tauri::async_runtime::spawn_blocking(move || {
        pick_path(picker_window, title, file_name.zip(extension))
    })
    .await
    .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };

    let name = path
        .to_str()
        .ok_or("Choose a destination with a readable name")?;
    let scopes = window.state::<tauri::scope::Scopes>();
    if let Some(scope) = window.try_fs_scope() {
        if directory {
            scope.allow_directory(&path, true)
        } else {
            scope.allow_file(&path)
        }
        .map_err(|error| error.to_string())?;
    }
    if directory {
        scopes.allow_directory(&path, true)
    } else {
        scopes.allow_file(&path)
    }
    .map_err(|error| error.to_string())?;
    Ok(Some(name.into()))
}

#[cfg(target_os = "macos")]
fn pick_path<R: Runtime>(
    _window: Window<R>,
    title: String,
    file: Option<(String, &str)>,
) -> Option<PathBuf> {
    // Use a standalone panel so export can confirm a destination when the editor is covered.
    let dialog = rfd::FileDialog::new().set_title(title);
    match file {
        Some((name, extension)) => dialog
            .set_file_name(name)
            .add_filter(
                format!("{} file", extension.to_ascii_uppercase()),
                &[extension],
            )
            .save_file(),
        None => dialog.pick_folder(),
    }
}

#[cfg(not(target_os = "macos"))]
fn pick_path<R: Runtime>(
    window: Window<R>,
    title: String,
    file: Option<(String, &str)>,
) -> Option<PathBuf> {
    let dialog = window.dialog().file().set_title(title);
    #[cfg(windows)]
    let dialog = dialog.set_parent(&window);
    let chosen = match file {
        Some((name, extension)) => dialog
            .set_file_name(name)
            .add_filter(
                format!("{} file", extension.to_ascii_uppercase()),
                &[extension],
            )
            .blocking_save_file(),
        None => dialog.blocking_pick_folder(),
    };
    chosen?.simplified().into_path().ok()
}
