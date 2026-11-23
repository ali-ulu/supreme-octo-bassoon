//! JS bindings for `scripts/lead-agent.mjs`: generated from the signatures in `port.rs` by rust-anything.
//! Regenerate with `rust-anything refresh` after changing them.

use napi_derive::napi;

pub mod js;
pub mod port;
pub mod wire;

#[allow(unused_imports)]
use serde_json::Value;
pub mod utf16;

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into())
}

#[allow(dead_code)]
fn run<T>(f: impl FnOnce() -> Result<T, String>) -> napi::Result<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(result) => result.map_err(napi::Error::from_reason),
        Err(payload) => Err(napi::Error::from_reason(format!(
            "Rust panic: {}",
            panic_message(&*payload)
        ))),
    }
}

/// `parseCsvRows`.
#[napi(js_name = "parseCsvRows")]
pub fn parse_csv_rows(text: String) -> napi::Result<String> {
    run(move || {
        let text = crate::js::from_json(&text)?;
        let out = port::parse_csv_rows(text)?;
        crate::js::to_json(&out)
    })
}

/// `normalizeHost`.
#[napi(js_name = "normalizeHost")]
pub fn normalize_host(input: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::normalize_host(input)?;
        crate::js::to_json(&out)
    })
}

/// `extractEmails`.
#[napi(js_name = "extractEmails")]
pub fn extract_emails(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::extract_emails(value)?;
        crate::js::to_json(&out)
    })
}

/// `leadFromRow`.
#[napi(js_name = "leadFromRow")]
pub fn lead_from_row(row: String, header: String) -> napi::Result<String> {
    run(move || {
        let row = crate::js::from_json(&row)?;
        let header = crate::js::from_json(&header)?;
        let out = port::lead_from_row(row, header)?;
        crate::js::to_json(&out)
    })
}

/// `importRows`.
#[napi(js_name = "importRows")]
pub fn import_rows(text: String) -> napi::Result<String> {
    run(move || {
        let text = crate::js::from_json(&text)?;
        let out = port::import_rows(text)?;
        crate::js::to_json(&out)
    })
}

/// `scanConversion`.
#[napi(js_name = "scanConversion")]
pub fn scan_conversion(html: String, final_url: String) -> napi::Result<String> {
    run(move || {
        let html = crate::js::from_json(&html)?;
        let final_url = crate::js::from_json(&final_url)?;
        let out = port::scan_conversion(html, final_url)?;
        crate::js::to_json(&out)
    })
}

/// `lossPoints`.
#[napi(js_name = "lossPoints")]
pub fn loss_points(analysis: String) -> napi::Result<String> {
    run(move || {
        let analysis = crate::js::from_json(&analysis)?;
        let out = port::loss_points(analysis)?;
        crate::js::to_json(&out)
    })
}

/// `chooseRoute`.
#[napi(js_name = "chooseRoute")]
pub fn choose_route(lead: String, analysis: String) -> napi::Result<String> {
    run(move || {
        let lead = crate::js::from_json(&lead)?;
        let analysis = crate::js::from_json(&analysis)?;
        let out = port::choose_route(lead, analysis)?;
        crate::js::to_json(&out)
    })
}

/// `topIssues`.
#[napi(js_name = "topIssues")]
pub fn top_issues(analysis: String, route: String) -> napi::Result<String> {
    run(move || {
        let analysis = crate::js::from_json(&analysis)?;
        let route = crate::js::from_json(&route)?;
        let out = port::top_issues(analysis, route)?;
        crate::js::to_json(&out)
    })
}

/// `buildDraft`.
#[napi(js_name = "buildDraft")]
pub fn build_draft(lead: String, analysis: String, route_arg: String) -> napi::Result<String> {
    run(move || {
        let lead = crate::js::from_json(&lead)?;
        let analysis = crate::js::from_json(&analysis)?;
        let route_arg = crate::js::from_json(&route_arg)?;
        let out = port::build_draft(lead, analysis, route_arg)?;
        crate::js::to_json(&out)
    })
}

/// `b64`.
#[napi(js_name = "b64")]
pub fn b64(s: String) -> napi::Result<String> {
    run(move || {
        let s = crate::js::from_json(&s)?;
        let out = port::b64(s)?;
        crate::js::to_json(&out)
    })
}

/// `rfc2047`.
#[napi(js_name = "rfc2047")]
pub fn rfc2047(s: String) -> napi::Result<String> {
    run(move || {
        let s = crate::js::from_json(&s)?;
        let out = port::rfc2047(s)?;
        crate::js::to_json(&out)
    })
}

/// `buildMime`.
#[napi(js_name = "buildMime")]
pub fn build_mime(arg0: String) -> napi::Result<String> {
    run(move || {
        let arg0 = crate::js::from_json(&arg0)?;
        let out = port::build_mime(arg0)?;
        crate::js::to_json(&out)
    })
}

// ---- the binary wire ------------------------------------------------------------------------

type WireBuffers = (
    napi::bindgen_prelude::Uint8Array,
    napi::bindgen_prelude::Uint8Array,
    napi::bindgen_prelude::Uint32Array,
);

thread_local! {
    static WIRE: std::cell::RefCell<Option<WireBuffers>> = const { std::cell::RefCell::new(None) };
    static PENDING: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
    static SCRATCH: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Registers the argument, result and argument-length buffers `index.cjs` uses.
#[napi(js_name = "rustAnythingWireInit")]
pub fn rust_anything_wire_init(
    input: napi::bindgen_prelude::Uint8Array,
    output: napi::bindgen_prelude::Uint8Array,
    len: napi::bindgen_prelude::Uint32Array,
) {
    WIRE.with(|w| *w.borrow_mut() = Some((input, output, len)));
}

/// Copies a result that did not fit into the (now larger) result buffer.
#[napi(js_name = "rustAnythingWireFlush")]
pub fn rust_anything_wire_flush() -> f64 {
    let bytes = PENDING.with(|p| std::mem::take(&mut *p.borrow_mut()));
    WIRE.with(|w| {
        let mut w = w.borrow_mut();
        let Some((_, output, _)) = w.as_mut() else {
            return -1.0;
        };
        // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
        let out = unsafe { output.as_mut() };
        let n = bytes.len().min(out.len());
        out[..n].copy_from_slice(&bytes[..n]);
        n as f64
    })
}

/// Reads the argument bytes (`wLen[0]` of them), runs `f`, and writes its result; a negative
/// return is the size of a result that did not fit, kept for `rustAnythingWireFlush`.
fn wire_io(
    f: impl FnOnce(&mut wire::Reader, &mut wire::Writer) -> Result<(), String>,
) -> napi::Result<f64> {
    WIRE.with(|cell| {
        let mut guard = cell.borrow_mut();
        let Some((input, output, len)) = guard.as_mut() else {
            return Err(napi::Error::from_reason(
                "rust-anything: the wire buffers are not registered",
            ));
        };
        let len = (len.first().copied().unwrap_or(0) as usize).min(input.len());
        let mut w = wire::Writer(SCRATCH.with(|s| std::mem::take(&mut *s.borrow_mut())));
        w.0.clear();
        let result = run(|| f(&mut wire::Reader::new(&input[..len]), &mut w));
        let keep = |w: wire::Writer| SCRATCH.with(|s| *s.borrow_mut() = w.0);
        match result {
            // A result of another shape than the TS type: JS runs the call through JSON.
            Err(e) if e.reason.starts_with(wire::MISMATCH) => {
                keep(w);
                return Ok(f64::NAN);
            }
            Err(e) => {
                keep(w);
                let mut m = wire::Writer::default();
                m.string16(&e.reason);
                // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
                let out = unsafe { output.as_mut() };
                if m.0.len() > out.len() {
                    return Err(e);
                }
                out[..m.0.len()].copy_from_slice(&m.0);
                return Ok(f64::INFINITY);
            }
            Ok(()) => {}
        }
        // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
        let out = unsafe { output.as_mut() };
        let n = w.0.len();
        if n > out.len() {
            PENDING.with(|p| *p.borrow_mut() = w.0);
            return Ok(-(n as f64));
        }
        out[..n].copy_from_slice(&w.0);
        keep(w);
        Ok(n as f64)
    })
}

static S_PARSE_CSV_ROWS_0: wire::Schema = wire::Schema::Dyn;
static S_PARSE_CSV_ROWS_OUT: wire::Schema = wire::Schema::Dyn;

/// `parseCsvRows` over the binary wire.
#[napi(js_name = "parseCsvRowsWire")]
pub fn parse_csv_rows_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let text: serde_json::Value = wire::read_value(r, &S_PARSE_CSV_ROWS_0)?;
        let out = &port::parse_csv_rows(text)?;
        wire::write_value(w, out, &S_PARSE_CSV_ROWS_OUT)?;
        Ok(())
    })
}

static S_NORMALIZE_HOST_0: wire::Schema = wire::Schema::Dyn;
static S_NORMALIZE_HOST_OUT: wire::Schema = wire::Schema::Dyn;

/// `normalizeHost` over the binary wire.
#[napi(js_name = "normalizeHostWire")]
pub fn normalize_host_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_NORMALIZE_HOST_0)?;
        let out = &port::normalize_host(input)?;
        wire::write_value(w, out, &S_NORMALIZE_HOST_OUT)?;
        Ok(())
    })
}

static S_EXTRACT_EMAILS_0: wire::Schema = wire::Schema::Dyn;
static S_EXTRACT_EMAILS_OUT: wire::Schema = wire::Schema::Dyn;

/// `extractEmails` over the binary wire.
#[napi(js_name = "extractEmailsWire")]
pub fn extract_emails_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: serde_json::Value = wire::read_value(r, &S_EXTRACT_EMAILS_0)?;
        let out = &port::extract_emails(value)?;
        wire::write_value(w, out, &S_EXTRACT_EMAILS_OUT)?;
        Ok(())
    })
}

static S_LEAD_FROM_ROW_0: wire::Schema = wire::Schema::Dyn;
static S_LEAD_FROM_ROW_1: wire::Schema = wire::Schema::Dyn;
static S_LEAD_FROM_ROW_OUT: wire::Schema = wire::Schema::Dyn;

/// `leadFromRow` over the binary wire.
#[napi(js_name = "leadFromRowWire")]
pub fn lead_from_row_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let row: serde_json::Value = wire::read_value(r, &S_LEAD_FROM_ROW_0)?;
        let header: serde_json::Value = wire::read_value(r, &S_LEAD_FROM_ROW_1)?;
        let out = &port::lead_from_row(row, header)?;
        wire::write_value(w, out, &S_LEAD_FROM_ROW_OUT)?;
        Ok(())
    })
}

static S_IMPORT_ROWS_0: wire::Schema = wire::Schema::Dyn;
static S_IMPORT_ROWS_OUT: wire::Schema = wire::Schema::Dyn;

/// `importRows` over the binary wire.
#[napi(js_name = "importRowsWire")]
pub fn import_rows_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let text: serde_json::Value = wire::read_value(r, &S_IMPORT_ROWS_0)?;
        let out = &port::import_rows(text)?;
        wire::write_value(w, out, &S_IMPORT_ROWS_OUT)?;
        Ok(())
    })
}

static S_SCAN_CONVERSION_0: wire::Schema = wire::Schema::Dyn;
static S_SCAN_CONVERSION_1: wire::Schema = wire::Schema::Dyn;
static S_SCAN_CONVERSION_OUT: wire::Schema = wire::Schema::Dyn;

/// `scanConversion` over the binary wire.
#[napi(js_name = "scanConversionWire")]
pub fn scan_conversion_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let html: serde_json::Value = wire::read_value(r, &S_SCAN_CONVERSION_0)?;
        let final_url: serde_json::Value = wire::read_value(r, &S_SCAN_CONVERSION_1)?;
        let out = &port::scan_conversion(html, final_url)?;
        wire::write_value(w, out, &S_SCAN_CONVERSION_OUT)?;
        Ok(())
    })
}

static S_LOSS_POINTS_0: wire::Schema = wire::Schema::Dyn;
static S_LOSS_POINTS_OUT: wire::Schema = wire::Schema::Dyn;

/// `lossPoints` over the binary wire.
#[napi(js_name = "lossPointsWire")]
pub fn loss_points_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let analysis: serde_json::Value = wire::read_value(r, &S_LOSS_POINTS_0)?;
        let out = &port::loss_points(analysis)?;
        wire::write_value(w, out, &S_LOSS_POINTS_OUT)?;
        Ok(())
    })
}

static S_CHOOSE_ROUTE_0: wire::Schema = wire::Schema::Dyn;
static S_CHOOSE_ROUTE_1: wire::Schema = wire::Schema::Dyn;
static S_CHOOSE_ROUTE_OUT: wire::Schema = wire::Schema::Dyn;

/// `chooseRoute` over the binary wire.
#[napi(js_name = "chooseRouteWire")]
pub fn choose_route_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let lead: serde_json::Value = wire::read_value(r, &S_CHOOSE_ROUTE_0)?;
        let analysis: serde_json::Value = wire::read_value(r, &S_CHOOSE_ROUTE_1)?;
        let out = &port::choose_route(lead, analysis)?;
        wire::write_value(w, out, &S_CHOOSE_ROUTE_OUT)?;
        Ok(())
    })
}

static S_TOP_ISSUES_0: wire::Schema = wire::Schema::Dyn;
static S_TOP_ISSUES_1: wire::Schema = wire::Schema::Dyn;
static S_TOP_ISSUES_OUT: wire::Schema = wire::Schema::Dyn;

/// `topIssues` over the binary wire.
#[napi(js_name = "topIssuesWire")]
pub fn top_issues_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let analysis: serde_json::Value = wire::read_value(r, &S_TOP_ISSUES_0)?;
        let route: serde_json::Value = wire::read_value(r, &S_TOP_ISSUES_1)?;
        let out = &port::top_issues(analysis, route)?;
        wire::write_value(w, out, &S_TOP_ISSUES_OUT)?;
        Ok(())
    })
}

static S_BUILD_DRAFT_0: wire::Schema = wire::Schema::Dyn;
static S_BUILD_DRAFT_1: wire::Schema = wire::Schema::Dyn;
static S_BUILD_DRAFT_2: wire::Schema = wire::Schema::Dyn;
static S_BUILD_DRAFT_OUT: wire::Schema = wire::Schema::Dyn;

/// `buildDraft` over the binary wire.
#[napi(js_name = "buildDraftWire")]
pub fn build_draft_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let lead: serde_json::Value = wire::read_value(r, &S_BUILD_DRAFT_0)?;
        let analysis: serde_json::Value = wire::read_value(r, &S_BUILD_DRAFT_1)?;
        let route_arg: serde_json::Value = wire::read_value(r, &S_BUILD_DRAFT_2)?;
        let out = &port::build_draft(lead, analysis, route_arg)?;
        wire::write_value(w, out, &S_BUILD_DRAFT_OUT)?;
        Ok(())
    })
}

static S_B64_0: wire::Schema = wire::Schema::Dyn;
static S_B64_OUT: wire::Schema = wire::Schema::Dyn;

/// `b64` over the binary wire.
#[napi(js_name = "b64Wire")]
pub fn b64_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let s: serde_json::Value = wire::read_value(r, &S_B64_0)?;
        let out = &port::b64(s)?;
        wire::write_value(w, out, &S_B64_OUT)?;
        Ok(())
    })
}

static S_RFC2047_0: wire::Schema = wire::Schema::Dyn;
static S_RFC2047_OUT: wire::Schema = wire::Schema::Dyn;

/// `rfc2047` over the binary wire.
#[napi(js_name = "rfc2047Wire")]
pub fn rfc2047_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let s: serde_json::Value = wire::read_value(r, &S_RFC2047_0)?;
        let out = &port::rfc2047(s)?;
        wire::write_value(w, out, &S_RFC2047_OUT)?;
        Ok(())
    })
}

static S_BUILD_MIME_0: wire::Schema = wire::Schema::Dyn;
static S_BUILD_MIME_OUT: wire::Schema = wire::Schema::Dyn;

/// `buildMime` over the binary wire.
#[napi(js_name = "buildMimeWire")]
pub fn build_mime_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let arg0: serde_json::Value = wire::read_value(r, &S_BUILD_MIME_0)?;
        let out = &port::build_mime(arg0)?;
        wire::write_value(w, out, &S_BUILD_MIME_OUT)?;
        Ok(())
    })
}
