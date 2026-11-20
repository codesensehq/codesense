// SPDX-License-Identifier: MIT
//! PDF rendering via a bare WebKitGTK web view in an offscreen window (Linux).
//!
//! The web view is not a Tauri window and has no IPC bridge: the page is repo
//! content with its own scripts, and it must not reach app commands. Each
//! export gets its own ephemeral web context, so no cookie or storage carries
//! from one export to the next, and the page can't download a file.
//!
//! The page loads, then a WebKitGTK print operation prints it, with no dialog,
//! through GTK's file printer to `out.pdf` in a temporary directory, and
//! `render` reads the bytes back. Pages are US Letter with GTK's default
//! margins; macOS's `createPDF` makes one page 612pt wide and as tall as the
//! content instead.
//!
//! All GTK work runs on the main thread, where the app's event loop iterates
//! GLib's default main context. Each export's window is parked in a
//! main-thread registry, and a drop guard destroys it, with the web view in
//! it, when the export completes, fails or is dropped by the command's
//! timeout, so no window outlives its export.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{c_char, CStr};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use gtk::glib;
use gtk::glib::ffi::{gboolean, gpointer, GDestroyNotify, GFALSE};
use gtk::prelude::*;
use log::{debug, error};
use tokio::sync::oneshot;
use webkit2gtk::{
    DownloadExt, LoadEvent, NavigationPolicyDecision, NavigationPolicyDecisionExt, NavigationType,
    PolicyDecision, PolicyDecisionExt, PolicyDecisionType, PrintOperation, PrintOperationExt,
    ResponsePolicyDecision, ResponsePolicyDecisionExt, URIResponseExt, WebContext, WebContextExt,
    WebView, WebViewExt,
};

use super::ContentSource;

/// Render `source` to PDF bytes. The web view is made, driven and destroyed on
/// the main thread; this future only waits for it.
pub(super) async fn render(source: ContentSource) -> Result<Vec<u8>, String> {
    let dir = tempfile::tempdir()
        .map_err(|e| format!("Failed to create a temporary directory: {}", e))?;
    let out = tempfile::TempDir::path(&dir).join("out.pdf");
    let (tx, rx) = oneshot::channel();
    let export = Export::start(source, out.clone(), tx);
    let printed = rx
        .await
        .map_err(|_| "PDF export channel closed unexpectedly".to_string())?;
    drop(export);
    printed?;
    tokio::fs::read(&out)
        .await
        .map_err(|e| format!("Failed to read the printed PDF: {}", e))
}

// ---------------------------------------------------------------------------
// In-flight exports
// ---------------------------------------------------------------------------

thread_local! {
    /// Each in-flight export's window, by export id. Main thread only.
    static PARKED: RefCell<HashMap<usize, gtk::OffscreenWindow>> = RefCell::new(HashMap::new());
}

static NEXT_EXPORT_ID: AtomicUsize = AtomicUsize::new(0);

/// One export in flight. Dropping it destroys its window and web view on the
/// main thread: after the export completes or fails, or when the command's
/// timeout drops the future that owns it.
struct Export {
    id: usize,
    /// Set on drop, so a start that reaches the main thread after it makes nothing.
    over: Arc<AtomicBool>,
}

impl Export {
    /// Schedule the export on the main thread: an offscreen web view loads
    /// `source` and prints it to `out`, and `tx` gets the outcome.
    fn start(source: ContentSource, out: PathBuf, tx: oneshot::Sender<Result<(), String>>) -> Self {
        let id = NEXT_EXPORT_ID.fetch_add(1, Ordering::Relaxed);
        let over = Arc::new(AtomicBool::new(false));
        let dropped = over.clone();
        glib::idle_add_once(move || {
            eprintln!(
                "diag: idle start {id} dropped={}",
                dropped.load(Ordering::Acquire)
            );
            if dropped.load(Ordering::Acquire) {
                return;
            }
            let (window, web_view) = offscreen_view();
            PARKED.with(|parked| parked.borrow_mut().insert(id, window));
            print_to_pdf(&web_view, source, &out, move |result| {
                let _ = tx.send(result);
            });
        });
        Self { id, over }
    }
}

impl Drop for Export {
    fn drop(&mut self) {
        self.over.store(true, Ordering::Release);
        let id = self.id;
        eprintln!("diag: guard drop {id}");
        glib::idle_add_once(move || release(id));
    }
}

/// Scratch: destroy `window`, first stopping and terminating its web view when
/// PDF_DIAG_TERMINATE is set.
fn teardown(window: &gtk::OffscreenWindow) {
    if std::env::var_os("PDF_DIAG_TERMINATE").is_some() {
        if let Some(view) = window.child().and_then(|c| c.downcast::<WebView>().ok()) {
            eprintln!("diag: stop_loading");
            view.stop_loading();
            eprintln!("diag: terminate_web_process");
            view.terminate_web_process();
            eprintln!("diag: terminated");
        }
    }
    eprintln!("diag: destroy begin");
    // SAFETY: the caller's handle is the last one read.
    unsafe { window.destroy() };
    eprintln!("diag: destroy end");
}

/// Destroy export `id`'s window and the web view in it. Main thread only.
fn release(id: usize) {
    let window = PARKED.with(|parked| parked.borrow_mut().remove(&id));
    eprintln!("diag: release {id} parked={}", window.is_some());
    if let Some(window) = window {
        debug!(target: "export_pdf", "Releasing export {}", id);
        teardown(&window);
    }
}

// ---------------------------------------------------------------------------
// The web view and the print
// ---------------------------------------------------------------------------

#[cfg(test)]
thread_local! {
    /// How many web views `offscreen_view` has made on this thread.
    static VIEWS_MADE: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// The decisions the policy handler ignored on this thread.
    static IGNORED: RefCell<Vec<Decided>> = const { RefCell::new(Vec::new()) };
}

/// A bare web view on its own ephemeral context, in an offscreen window sized
/// to a US Letter page at 96 dpi. The page can't download: a download it
/// starts is refused at the policy decision, and one that starts anyway is
/// cancelled, so an export never writes a file of the page's choosing. Main
/// thread only.
fn offscreen_view() -> (gtk::OffscreenWindow, WebView) {
    #[cfg(test)]
    VIEWS_MADE.with(|made| made.set(made.get() + 1));
    let context = WebContext::new_ephemeral();
    context.connect_download_started(|_, download| {
        debug!(target: "export_pdf", "Cancelling a download the page started");
        download.cancel();
    });
    let web_view = WebView::with_context(&context);
    web_view.connect_decide_policy(|_, decision, kind| {
        let decided = decided(decision, kind);
        if allowed(&decided) {
            return false;
        }
        #[cfg(test)]
        IGNORED.with(|ignored| ignored.borrow_mut().push(decided));
        debug!(target: "export_pdf", "Ignoring a {:?} the page asked for", decided);
        decision.ignore();
        true
    });
    let window = gtk::OffscreenWindow::new();
    window.set_default_size(816, 1056);
    ContainerExt::add(&window, &web_view);
    window.show_all();
    (window, web_view)
}

/// A policy decision, as far as telling a download from a page load needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decided {
    /// Navigating a frame, and how.
    Navigation(NavigationType),
    /// Opening a new window.
    NewWindow,
    /// A frame's response: whether the web view can show it, and whether it
    /// is sent as an attachment (`Content-Disposition: attachment`).
    Response {
        displayable: bool,
        attachment: bool,
    },
    Other,
}

fn decided(decision: &PolicyDecision, kind: PolicyDecisionType) -> Decided {
    match kind {
        PolicyDecisionType::NavigationAction => decision
            .downcast_ref::<NavigationPolicyDecision>()
            .and_then(|navigation| navigation.navigation_action())
            .map_or(Decided::Other, |action| {
                Decided::Navigation(action.navigation_type())
            }),
        PolicyDecisionType::NewWindowAction => Decided::NewWindow,
        PolicyDecisionType::Response => {
            let Some(response) = decision.downcast_ref::<ResponsePolicyDecision>() else {
                return Decided::Other;
            };
            let attachment = response
                .response()
                .and_then(|response| response.http_headers())
                .and_then(|headers| headers.one("Content-Disposition"))
                .is_some_and(|value| {
                    value
                        .trim_start()
                        .get(..10)
                        .is_some_and(|kind| kind.eq_ignore_ascii_case("attachment"))
                });
            Decided::Response {
                displayable: response.is_mime_type_supported(),
                attachment,
            }
        }
        _ => Decided::Other,
    }
}

/// Whether an export's web view goes ahead with `decision`. The page loads,
/// with its frames and their redirects, but a download goes no further: an
/// attachment, a response it can't show (WebKit downloads those), a link
/// click or a form submission (where a `download` attribute acts; a printed
/// page has no one to click) and a new window are all ignored.
fn allowed(decision: &Decided) -> bool {
    match *decision {
        Decided::Navigation(how) => !matches!(
            how,
            NavigationType::LinkClicked
                | NavigationType::FormSubmitted
                | NavigationType::FormResubmitted
        ),
        Decided::NewWindow => false,
        Decided::Response {
            displayable,
            attachment,
        } => displayable && !attachment,
        Decided::Other => true,
    }
}

/// The outcome callback, taken by whichever signal ends the export first.
type Done = Rc<RefCell<Option<Box<dyn FnOnce(Result<(), String>)>>>>;

fn finish(done: &Done, result: Result<(), String>) {
    let callback = done.borrow_mut().take();
    if let Some(callback) = callback {
        callback(result);
    }
}

/// Load `source` into `web_view` and print it as PDF to `out`. `done` gets the
/// outcome once: `Ok` when the file is written. Main thread only.
fn print_to_pdf(
    web_view: &WebView,
    source: ContentSource,
    out: &Path,
    done: impl FnOnce(Result<(), String>) + 'static,
) {
    let callback: Box<dyn FnOnce(Result<(), String>)> = Box::new(done);
    let done: Done = Rc::new(RefCell::new(Some(callback)));
    let printer = match file_printer() {
        Ok(printer) => printer,
        Err(e) => return finish(&done, Err(e)),
    };
    let Ok(uri) = url::Url::from_file_path(out) else {
        return finish(
            &done,
            Err(format!("Not an absolute path: {}", Path::display(out))),
        );
    };
    let uri = uri.to_string();

    let failed = done.clone();
    web_view.connect_load_failed(move |_, _, failing_uri, err| {
        let msg = format!("Loading {} failed: {}", failing_uri, err);
        error!(target: "export_pdf", "{}", msg);
        finish(&failed, Err(msg));
        // Handled: no error page.
        true
    });
    let printing = Rc::new(std::cell::Cell::new(false));
    web_view.connect_load_changed(move |web_view, event| {
        // A failed load finishes too, after `load-failed` took the callback.
        if event != LoadEvent::Finished
            || done.borrow().is_none()
            || std::cell::Cell::replace(&printing, true)
        {
            return;
        }
        debug!(target: "export_pdf", "Load finished; printing to file");
        start_print(web_view, &printer, &uri, done.clone());
    });
    match source {
        ContentSource::Url(url) => web_view.load_uri(&url),
        ContentSource::Html(html) => web_view.load_html(&html, None),
    }
}

/// Print `web_view` through `printer` to the file at `uri`, with no dialog.
fn start_print(web_view: &WebView, printer: &str, uri: &str, done: Done) {
    let settings = gtk::PrintSettings::new();
    settings.set_printer(printer);
    settings.set(
        glib::GStr::as_str(gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT),
        Some("pdf"),
    );
    settings.set(
        glib::GStr::as_str(gtk::PRINT_SETTINGS_OUTPUT_URI),
        Some(uri),
    );
    let page = gtk::PageSetup::new();
    page.set_paper_size_and_default_margins(&gtk::PaperSize::new(Some(glib::GStr::as_str(
        gtk::PAPER_NAME_LETTER,
    ))));

    let operation = PrintOperation::new(web_view);
    operation.set_print_settings(&settings);
    operation.set_page_setup(&page);
    // Held by its own handlers until it ends; dropped there, which breaks the cycle.
    let held = Rc::new(RefCell::new(Some(operation.clone())));
    // `failed` is emitted before `finished`, so connect it first: a failure is
    // never read as a success.
    let (failed, failed_held) = (done.clone(), held.clone());
    operation.connect_failed(move |_, err| {
        let msg = format!("Printing failed: {}", err);
        error!(target: "export_pdf", "{}", msg);
        finish(&failed, Err(msg));
        failed_held.borrow_mut().take();
    });
    operation.connect_finished(move |_| {
        finish(&done, Ok(()));
        held.borrow_mut().take();
    });
    operation.print();
}

// ---------------------------------------------------------------------------
// The file printer
// ---------------------------------------------------------------------------

/// GTK's printer, from `gtkunixprint.h`, which the gtk crate doesn't bind. Its
/// functions are in libgtk-3, which the gtk crate already links.
#[repr(C)]
struct GtkPrinter {
    _private: [u8; 0],
}

type GtkPrinterFunc = unsafe extern "C" fn(*mut GtkPrinter, gpointer) -> gboolean;

extern "C" {
    fn gtk_enumerate_printers(
        func: GtkPrinterFunc,
        data: gpointer,
        destroy: GDestroyNotify,
        wait: gboolean,
    );
    fn gtk_printer_get_name(printer: *mut GtkPrinter) -> *const c_char;
    fn gtk_printer_is_virtual(printer: *mut GtkPrinter) -> gboolean;
    fn gtk_printer_accepts_pdf(printer: *mut GtkPrinter) -> gboolean;
}

/// One printer GTK lists, as far as choosing the file printer needs.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Printer {
    name: String,
    /// It writes a file rather than reach a device.
    is_virtual: bool,
    accepts_pdf: bool,
}

/// GTK's translation of its file printer's name, in this process's locale.
fn file_printer_name() -> String {
    glib::dgettext(Some("gtk30"), "Print to File").to_string()
}

/// The printers GTK has listed so far, filled in by [`each_printer`].
struct Search {
    preferred: String,
    printers: Vec<Printer>,
}

/// GTK's printer callback: note the printer, and stop at GTK's own file printer.
extern "C" fn each_printer(printer: *mut GtkPrinter, data: gpointer) -> gboolean {
    // SAFETY: `data` is the `Rc<RefCell<Search>>` reference `file_printer`
    // gave GTK, which only `free_search` releases, and GTK passes a live
    // printer whose name it owns. GTK calls this on the main thread only, and
    // never while `file_printer` holds a borrow.
    let search = unsafe { &*data.cast::<RefCell<Search>>() };
    let name = unsafe { gtk_printer_get_name(printer) };
    if name.is_null() {
        return GFALSE;
    }
    let name = unsafe { CStr::from_ptr(name) }
        .to_string_lossy()
        .into_owned();
    let (is_virtual, accepts_pdf) = unsafe {
        (
            gtk_printer_is_virtual(printer) != 0,
            gtk_printer_accepts_pdf(printer) != 0,
        )
    };
    let mut search = search.borrow_mut();
    let found = is_virtual && accepts_pdf && name == search.preferred;
    search.printers.push(Printer {
        name,
        is_virtual,
        accepts_pdf,
    });
    gboolean::from(found)
}

/// GTK's destroy notify for the enumeration: release its `Search` reference.
unsafe extern "C" fn free_search(data: gpointer) {
    // SAFETY: `data` came from `Rc::into_raw` in `file_printer`, and GTK
    // calls this once, after its last `each_printer`.
    drop(unsafe { Rc::from_raw(data.cast::<RefCell<Search>>().cast_const()) });
}

/// The name of the printer to print PDF files through, from the printers GTK
/// lists at once. GTK's file printer is one of them, since its backend lists
/// it as it loads; waiting for the others (CUPS on the network) could block
/// the main thread, so they are not waited for. GTK holds its own reference
/// to the search, and may still call into it after this returns, until it
/// frees it through `free_search`. Main thread only.
fn file_printer() -> Result<String, String> {
    let search = Rc::new(RefCell::new(Search {
        preferred: file_printer_name(),
        printers: Vec::new(),
    }));
    let data = Rc::into_raw(search.clone()).cast_mut().cast();
    // SAFETY: GTK owns the reference in `data` until it calls `free_search`.
    eprintln!("diag: enumerate begin");
    unsafe { gtk_enumerate_printers(each_printer, data, Some(free_search), GFALSE) };
    eprintln!(
        "diag: enumerate end, {} printers",
        search.borrow().printers.len()
    );
    let search = search.borrow();
    choose_file_printer(&search.printers, &search.preferred)
}

/// The virtual printer that takes PDF, preferring the one named `preferred`
/// (GTK's file printer, in this locale) when more than one does. A real
/// printer is never chosen: with no such printer, an error.
fn choose_file_printer(printers: &[Printer], preferred: &str) -> Result<String, String> {
    let mut candidates = printers
        .iter()
        .filter(|printer| printer.is_virtual && printer.accepts_pdf);
    let first = candidates.clone().next().ok_or_else(|| {
        "No print-to-file printer: GTK's file print backend (libprintbackend-file.so) is missing"
            .to_string()
    })?;
    let chosen =
        Iterator::find(&mut candidates, |printer| printer.name == preferred).unwrap_or(first);
    Ok(chosen.name.clone())
}

#[cfg(test)]
mod tests {
    //! The tests that print need a display and GTK's print backends, so they
    //! are ignored: `rust-linux-app` runs them under `xvfb-run` with
    //! `--run-ignored all`. Each initializes GTK on its own thread, so run them
    //! with nextest, which gives every test its own process. They read the PDF
    //! back with poppler's `pdfinfo` and `pdftotext`.
    use super::*;
    use std::cell::Cell;
    use std::fs;
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use std::process::Command;
    use std::time::{Duration, Instant};

    /// A virtual printer that takes PDF when `pdf_file`, else a real one that doesn't.
    fn printer(name: &str, pdf_file: bool) -> Printer {
        Printer {
            name: name.to_string(),
            is_virtual: pdf_file,
            accepts_pdf: pdf_file,
        }
    }

    #[test]
    fn the_only_virtual_pdf_printer_is_chosen() {
        let printers = [
            printer("Office laser", false),
            printer("Ausgabe in Datei", true),
        ];
        assert_eq!(
            choose_file_printer(&printers, "Print to File"),
            Ok("Ausgabe in Datei".to_string())
        );
    }

    #[test]
    fn the_file_printers_translated_name_breaks_a_tie() {
        let printers = [
            printer("Another PDF writer", true),
            printer("Ausgabe in Datei", true),
        ];
        assert_eq!(
            choose_file_printer(&printers, "Ausgabe in Datei"),
            Ok("Ausgabe in Datei".to_string())
        );
    }

    #[test]
    fn a_real_printer_is_never_chosen() {
        let printers = [
            printer("Print to File", false),
            printer("Office laser", false),
        ];
        assert!(choose_file_printer(&printers, "Print to File").is_err());
        assert!(choose_file_printer(&[], "Print to File").is_err());
    }

    #[test]
    fn a_virtual_printer_without_pdf_is_not_chosen() {
        let lpr = Printer {
            name: "Print to LPR".to_string(),
            is_virtual: true,
            accepts_pdf: false,
        };
        assert!(choose_file_printer(&[lpr], "Print to File").is_err());
        // A real printer that takes PDF isn't a file printer either.
        let device = Printer {
            name: "Office laser".to_string(),
            is_virtual: false,
            accepts_pdf: true,
        };
        assert!(choose_file_printer(&[device], "Print to File").is_err());
    }

    #[test]
    fn the_page_loads_but_never_downloads() {
        for how in [
            NavigationType::Other,
            NavigationType::Reload,
            NavigationType::BackForward,
        ] {
            assert!(allowed(&Decided::Navigation(how)), "{how:?}");
        }
        for how in [
            NavigationType::LinkClicked,
            NavigationType::FormSubmitted,
            NavigationType::FormResubmitted,
        ] {
            assert!(!allowed(&Decided::Navigation(how)), "{how:?}");
        }
        assert!(!allowed(&Decided::NewWindow));
        let response = |displayable, attachment| Decided::Response {
            displayable,
            attachment,
        };
        assert!(allowed(&response(true, false)));
        assert!(!allowed(&response(true, true)));
        assert!(!allowed(&response(false, false)));
        assert!(!allowed(&response(false, true)));
    }

    fn init_gtk() {
        gtk::init().expect("GTK needs a display: run the test under xvfb-run");
    }

    /// Iterate this thread's main context until `ready` has a value.
    fn run_until<T>(mut ready: impl FnMut() -> Option<T>) -> T {
        let context = glib::MainContext::default();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(value) = ready() {
                return value;
            }
            assert!(Instant::now() < deadline, "not done within 30 seconds");
            if !context.iteration(false) {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }

    /// Print `source` in a fresh offscreen web view, as an export does.
    fn print(source: ContentSource) -> Result<Vec<u8>, String> {
        let (window, web_view) = offscreen_view();
        assert!(
            web_view.is_ephemeral(),
            "an export's web view stores nothing"
        );
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out.pdf");
        let outcome = Rc::new(RefCell::new(None));
        let sink = outcome.clone();
        print_to_pdf(&web_view, source, &out, move |result| {
            eprintln!("diag: done callback");
            *sink.borrow_mut() = Some(result);
        });
        let result = run_until(|| outcome.borrow_mut().take());
        eprintln!("diag: print done ok={}", result.is_ok());
        teardown(&window);
        result.map(|()| fs::read(&out).expect("the printed PDF"))
    }

    fn poppler(tool: &str, pdf: &Path) -> String {
        let output = Command::new(tool)
            .arg(pdf)
            .arg("-")
            .output()
            .unwrap_or_else(|e| panic!("{tool} (poppler-utils) is needed: {e}"));
        assert!(output.status.success(), "{tool} failed: {output:?}");
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    /// `bytes` is a PDF with at least one page whose extracted text holds `text`.
    fn assert_pdf_with_text(bytes: &[u8], text: &str) {
        assert!(
            bytes.starts_with(b"%PDF-"),
            "not a PDF: {:?}",
            &bytes[..bytes.len().min(16)]
        );
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("check.pdf");
        fs::write(&pdf, bytes).unwrap();
        let info = Command::new("pdfinfo")
            .arg(&pdf)
            .output()
            .expect("pdfinfo (poppler-utils) is needed");
        let info = String::from_utf8_lossy(&info.stdout).into_owned();
        let pages: u32 = info
            .lines()
            .find_map(|line| line.strip_prefix("Pages:"))
            .and_then(|n| n.trim().parse().ok())
            .unwrap_or_else(|| panic!("no page count in pdfinfo's output: {info}"));
        assert!(pages >= 1, "a PDF with no pages");
        let extracted = poppler("pdftotext", &pdf);
        assert!(
            extracted.contains(text),
            "{text:?} isn't in the PDF's text: {extracted:?}"
        );
    }

    /// Serve `page` to every request on a local port, but `/attachment` as a
    /// download (`Content-Disposition: attachment`); storage needs an http origin.
    fn serve(page: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let (mut request, mut buf) = (Vec::new(), [0u8; 4096]);
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                let (kind, extra, body) = if request.starts_with(b"GET /attachment ") {
                    (
                        "text/plain",
                        "Content-Disposition: attachment; filename=\"attached.txt\"\r\n",
                        "attached",
                    )
                } else {
                    ("text/html; charset=utf-8", "", page)
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: {}\r\n{}\
                     Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                    kind,
                    extra,
                    body.len(),
                    body
                );
            }
        });
        url
    }

    const PAGE: &str = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head>\
        <body><h1>Exported heading</h1><p>Body text for the export.</p></body></html>";

    #[test]
    #[ignore = "needs a display and GTK's print backends: rust-linux-app runs it under xvfb-run"]
    fn html_prints_to_a_pdf() {
        init_gtk();
        let bytes = print(ContentSource::Html(PAGE.to_string())).expect("an HTML export");
        assert_pdf_with_text(&bytes, "Exported heading");
    }

    #[test]
    #[ignore = "needs a display and GTK's print backends: rust-linux-app runs it under xvfb-run"]
    fn a_file_url_prints_to_a_pdf() {
        init_gtk();
        let dir = tempfile::tempdir().unwrap();
        let page = dir.path().join("a page.html");
        fs::write(&page, PAGE).unwrap();
        let url = url::Url::from_file_path(&page).unwrap().to_string();
        let bytes = print(ContentSource::Url(url)).expect("a URL export");
        assert_pdf_with_text(&bytes, "Body text for the export.");
    }

    #[test]
    #[ignore = "needs a display and GTK's print backends: rust-linux-app runs it under xvfb-run"]
    fn a_load_failure_is_an_error() {
        init_gtk();
        let closed = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", closed.local_addr().unwrap());
        drop(closed);
        let err = print(ContentSource::Url(url)).expect_err("a refused connection");
        assert!(err.contains("failed"), "{err}");
    }

    #[test]
    #[ignore = "needs a display and GTK's print backends: rust-linux-app runs it under xvfb-run"]
    fn a_german_locale_still_finds_the_file_printer() {
        // Before GTK sets the locale from the environment.
        for name in ["LANGUAGE", "LANG", "LC_ALL"] {
            std::env::set_var(name, "de_DE.UTF-8");
        }
        init_gtk();
        assert_ne!(
            file_printer_name(),
            "Print to File",
            "GTK's German translations are missing (language-pack-gnome-de-base, a de_DE.UTF-8 \
             locale), so this test would pass without them"
        );
        assert_eq!(file_printer(), Ok(file_printer_name()));
        let bytes = print(ContentSource::Html(PAGE.to_string())).expect("an export in German");
        assert_pdf_with_text(&bytes, "Exported heading");
    }

    #[test]
    #[ignore = "needs a display and GTK's print backends: rust-linux-app runs it under xvfb-run"]
    fn two_exports_share_no_stored_data() {
        init_gtk();
        let url = serve(
            "<!DOCTYPE html><html><body><p id=\"out\">pending</p><script>\
             const before = localStorage.getItem('kept') || 'none';\
             localStorage.setItem('kept', 'stored');\
             document.getElementById('out').textContent =\
               'before=' + before + ' after=' + localStorage.getItem('kept');\
             </script></body></html>",
        );
        for export in ["first", "second"] {
            let bytes = print(ContentSource::Url(url.clone()))
                .unwrap_or_else(|e| panic!("the {export} export: {e}"));
            // The page stores a value and reads it back, so storage works; the
            // next export starts without it.
            assert_pdf_with_text(&bytes, "before=none after=stored");
        }
    }

    #[test]
    #[ignore = "needs a display and GTK's print backends: rust-linux-app runs it under xvfb-run"]
    fn dropping_an_export_destroys_its_window() {
        init_gtk();
        // A server that never answers, so the export is in flight when the
        // timeout would drop it.
        let stalled = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", stalled.local_addr().unwrap());
        let dir = tempfile::tempdir().unwrap();
        let (tx, _rx) = oneshot::channel();
        let export = Export::start(ContentSource::Url(url), dir.path().join("out.pdf"), tx);
        let id = export.id;
        let window = run_until(|| PARKED.with(|parked| parked.borrow().get(&id).cloned()));
        let destroyed = Rc::new(Cell::new(false));
        let seen = destroyed.clone();
        window.connect_destroy(move |_| seen.set(true));
        drop(window);
        drop(export);
        run_until(|| destroyed.get().then_some(()));
        assert!(PARKED.with(|parked| parked.borrow().is_empty()));
        drop(stalled);
    }

    #[test]
    #[ignore = "needs a display and GTK's print backends: rust-linux-app runs it under xvfb-run"]
    fn an_export_dropped_before_it_starts_makes_no_window() {
        init_gtk();
        let dir = tempfile::tempdir().unwrap();
        let (tx, mut rx) = oneshot::channel();
        let export = Export::start(
            ContentSource::Html(PAGE.to_string()),
            dir.path().join("out.pdf"),
            tx,
        );
        drop(export);
        let context = glib::MainContext::default();
        while context.iteration(false) {}
        assert_eq!(VIEWS_MADE.with(|made| made.get()), 0, "a web view was made");
        assert!(PARKED.with(|parked| parked.borrow().is_empty()));
        assert!(rx.try_recv().is_err(), "no export ran");
    }

    /// Every file under `dir`, at any depth.
    fn files_under(dir: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                found.extend(files_under(&path));
            } else {
                found.push(path);
            }
        }
        found
    }

    #[test]
    #[ignore = "needs a display and GTK's print backends: rust-linux-app runs it under xvfb-run"]
    fn a_page_that_downloads_still_exports_and_writes_no_file() {
        // A home and Downloads folder of the test's own, before GLib reads them.
        let home = tempfile::tempdir().unwrap();
        let downloads = home.path().join("Downloads");
        let config = home.path().join(".config");
        fs::create_dir_all(&downloads).unwrap();
        fs::create_dir_all(&config).unwrap();
        fs::write(
            config.join("user-dirs.dirs"),
            format!("XDG_DOWNLOAD_DIR=\"{}\"\n", downloads.display()),
        )
        .unwrap();
        std::env::set_var("HOME", home.path());
        std::env::set_var("XDG_CONFIG_HOME", &config);
        std::env::set_var("XDG_DOWNLOAD_DIR", &downloads);
        init_gtk();
        // A script-clicked download link and an attachment in a frame. (A scripted
        // window.open never reaches the policy: WebKit blocks it as a popup first,
        // so new windows are covered by the policy's own test.)
        let url = serve(
            "<!DOCTYPE html><html><body><p>Exported despite the downloads.</p>\
             <a id=\"save\" download=\"leaked.txt\" href=\"data:text/plain,leaked\">save</a>\
             <iframe src=\"/attachment\"></iframe>\
             <script>document.getElementById('save').click();</script></body></html>",
        );
        let bytes = print(ContentSource::Url(url)).expect("the export");
        assert_pdf_with_text(&bytes, "Exported despite the downloads.");
        // Time for a download that got through to land.
        let settle = Instant::now() + Duration::from_secs(2);
        run_until(|| (Instant::now() >= settle).then_some(()));
        // The page did try both, so the empty folders mean the policy held.
        let ignored = IGNORED.with(|ignored| ignored.borrow().clone());
        assert!(
            ignored.contains(&Decided::Navigation(NavigationType::LinkClicked)),
            "no download link click was ignored: {ignored:?}"
        );
        assert!(
            ignored.iter().any(|d| matches!(
                d,
                Decided::Response {
                    attachment: true,
                    ..
                }
            )),
            "no attachment response was ignored: {ignored:?}"
        );
        assert_eq!(files_under(&downloads), Vec::<PathBuf>::new());
        let leaked: Vec<_> = files_under(home.path())
            .into_iter()
            .filter(|path| {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                name.contains("leaked") || name.contains("attached")
            })
            .collect();
        assert_eq!(leaked, Vec::<PathBuf>::new());
    }
}
