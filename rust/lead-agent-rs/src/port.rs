//! The Rust port of `scripts/lead-agent.mjs`.

#![forbid(unsafe_code)]

mod pinned;

use crate::js;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::OnceLock;

// ── JS value semantics ─────────────────────────────────────────────────────────────────────────

fn undef() -> Value {
    js::undefined()
}

fn is_undef(v: &Value) -> bool {
    js::is_undefined(v)
}

fn is_nullish(v: &Value) -> bool {
    v.is_null() || is_undef(v)
}

fn js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_whitespace)
}

fn js_trim_owned(s: &str) -> String {
    js_trim(s).to_string()
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null | Value::Bool(false) => false,
        Value::Bool(true) => true,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) => true,
        Value::Object(o) => {
            if is_undef(v) {
                return false;
            }
            if let Some(b) = o.get("$bigint").and_then(Value::as_str) {
                return b.trim_start_matches('-') != "0";
            }
            if let Some(n) = o.get("$num").and_then(Value::as_str) {
                return matches!(n, "Infinity") || (n.parse::<f64>().is_ok_and(|x| x != 0.0));
            }
            true
        }
    }
}

fn js_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        Value::Null => "null".to_string(),
        Value::Number(n) => js::number_to_string(n.as_f64().unwrap_or_default()),
        Value::Array(items) => items
            .iter()
            .map(|e| {
                if is_nullish(e) {
                    String::new()
                } else {
                    js_str(e)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(o) => {
            if is_undef(v) {
                return "undefined".to_string();
            }
            if let Some(units) = js::string_units(v) {
                return String::from_utf16_lossy(&units);
            }
            if let Some(n) = js::as_number(v) {
                return js::number_to_string(n);
            }
            if o.len() == 1 {
                if let Some(b) = o.get("$bigint").and_then(Value::as_str) {
                    return b.to_string();
                }
                if let Some(iso) = o.get("$date").and_then(Value::as_str) {
                    return date_ms_from_iso(iso)
                        .map_or_else(|| "Invalid Date".to_string(), utc_string);
                }
                if o.contains_key("$map") {
                    return "[object Map]".to_string();
                }
                if o.contains_key("$set") {
                    return "[object Set]".to_string();
                }
            }
            "[object Object]".to_string()
        }
    }
}

fn to_num(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(_) => js::as_number(v).unwrap_or(f64::NAN),
        Value::String(s) => js_num_from_str(s),
        Value::Object(o) => {
            if let Some(n) = js::as_number(v) {
                n
            } else if let Some(b) = o.get("$bigint").and_then(Value::as_str) {
                b.parse::<f64>().unwrap_or(f64::NAN)
            } else {
                js_num_from_str(&js_str(v))
            }
        }
        _ => js_num_from_str(&js_str(v)),
    }
}

fn js_num_from_str(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let (neg, rest) = match t.as_bytes()[0] {
        b'+' => (false, &t[1..]),
        b'-' => (true, &t[1..]),
        _ => (false, t),
    };
    if rest.is_empty() {
        return f64::NAN;
    }
    if let Some(v) = radix_prefixed(rest, neg) {
        return v;
    }
    if rest == "Infinity" {
        return if neg {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    if !re_is_decimal().is_match(rest) {
        return f64::NAN;
    }
    let v: f64 = rest.parse().unwrap_or(f64::NAN); // INFALLIBLE: NaN fallback is the intended result for unparseable decimals
    if neg { -v } else { v }
}

fn radix_prefixed(rest: &str, neg: bool) -> Option<f64> {
    let prefixes = [
        ("0x", 16u32),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ];
    for (prefix, radix) in prefixes {
        if let Some(digits) = rest.strip_prefix(prefix) {
            let mut v: u128 = 0;
            if digits.is_empty() {
                return None;
            }
            for c in digits.chars() {
                let d = c.to_digit(radix)?;
                v = v
                    .checked_mul(u128::from(radix))?
                    .checked_add(u128::from(d))?;
            }
            let f = v as f64;
            return Some(if neg { -f } else { f });
        }
    }
    None
}

fn re_is_decimal() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$").unwrap() // INFALLIBLE: fixed pattern
    })
}

fn prop(v: &Value, key: &str) -> Result<Value, String> {
    match v {
        Value::Null => Err(format!("Cannot read properties of null (reading '{key}')")),
        _ if is_undef(v) => Err(format!(
            "Cannot read properties of undefined (reading '{key}')"
        )),
        Value::Array(items) => Ok(array_get(items, key).cloned().unwrap_or(undef())),
        Value::String(_) => {
            if key == "length" {
                return Ok(json!(units_of(v).len()));
            }
            match canonical_index(key).and_then(|i| units_of(v).get(i).copied()) {
                Some(unit) => Ok(js::utf16_string(&[unit])),
                None => Ok(undef()),
            }
        }
        Value::Object(o) => Ok(o.get(key).cloned().unwrap_or(undef())),
        _ => Ok(undef()),
    }
}

fn canonical_index(key: &str) -> Option<usize> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) || key.len() > 9 {
        return None;
    }
    if key.bytes().all(|b| b.is_ascii_digit()) {
        key.parse().ok()
    } else {
        None
    }
}

fn array_get<'a>(items: &'a [Value], key: &str) -> Option<&'a Value> {
    items.get(canonical_index(key)?)
}

fn units_of(v: &Value) -> Vec<u16> {
    js::string_units(v).unwrap_or_default()
}

fn re_ws_plus() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new("[\t\n\u{000B}\u{000C}\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]+")
            .unwrap() // INFALLIBLE: fixed pattern
    })
}

// ── Dates ───────────────────────────────────────────────────────────────────────────────────────

fn date_parts(ms: f64) -> (i64, u32, u32, u32, u32, u32, u32) {
    let total = ms.floor();
    let secs = (total / 1000.0).floor() as i64;
    let msec = total - (secs as f64) * 1000.0;
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400) as u32;
    let (y, m, d) = civil_from_days(days);
    (
        y,
        m,
        d,
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60,
        msec as u32,
    )
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = u64_as_i64(yoe) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d as u32)
}

fn u64_as_i64(n: u64) -> i64 {
    if n <= i64::from(u32::MAX) as u64 {
        n as i64
    } else {
        i64::from(u32::MAX)
    }
}

const DAY_NAMES: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

fn utc_string(ms: f64) -> String {
    let (y, mo, d, h, mi, s, _) = date_parts(ms);
    let wd = (((ms.div_euclid(86_400_000.0) as i64) + 4).rem_euclid(7)) as usize;
    format!(
        "{}, {:02} {} {} {:02}:{:02}:{:02} GMT",
        DAY_NAMES[wd % 7],
        d,
        MONTH_NAMES[(mo as usize - 1) % 12],
        y,
        h,
        mi,
        s
    )
}

fn iso_string(ms: f64) -> String {
    let (y, mo, d, h, mi, s, msec) = date_parts(ms);
    if !(0..=9999).contains(&y) {
        let sign = if y < 0 { '-' } else { '+' };
        return format!(
            "{}{:06}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            sign,
            y.abs(),
            mo,
            d,
            h,
            mi,
            s,
            msec
        );
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, mo, d, h, mi, s, msec
    )
}

fn date_ms_from_iso(iso: &str) -> Option<f64> {
    let c = re_iso_date().captures(iso)?;
    let y: i64 = c.name("y")?.as_str().parse().ok()?;
    let mo: u32 = c.name("mo")?.as_str().parse().ok()?;
    let d: u32 = c.name("d")?.as_str().parse().ok()?;
    let get = |name: &str, default: u32| -> u32 {
        c.name(name)
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(default)
    };
    let days = days_from_civil(y, mo, d);
    Some(
        f64::from(days as i32) * 86_400_000.0
            + f64::from(get("h", 0)) * 3_600_000.0
            + f64::from(get("mi", 0)) * 60_000.0
            + f64::from(get("s", 0)) * 1000.0
            + f64::from(get("ms", 0)),
    )
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let yy = if m <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn re_iso_date() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"^(?<y>-?[0-9]{4,6})-(?<mo>[0-9]{2})-(?<d>[0-9]{2})(?:T(?<h>[0-9]{2}):(?<mi>[0-9]{2}):(?<s>[0-9]{2})(?:\.(?<ms>[0-9]{1,3}))?Z)?$",
        )
        .unwrap() // INFALLIBLE: fixed pattern
    })
}

// ── Encodings ───────────────────────────────────────────────────────────────────────────────────

const B64_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk
            .first()
            .and_then(|_| chunk.get(1))
            .map_or(0, |b| u32::from(*b));
        let b2 = chunk.get(2).map_or(0, |b| u32::from(*b));
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(char_of(B64_ALPHABET[(n >> 18) as usize & 63]));
        out.push(char_of(B64_ALPHABET[(n >> 12) as usize & 63]));
        out.push(if chunk.len() > 1 {
            char_of(B64_ALPHABET[(n >> 6) as usize & 63])
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            char_of(B64_ALPHABET[n as usize & 63])
        } else {
            '='
        });
    }
    out
}

fn char_of(b: u8) -> char {
    b as char
}

fn string_bytes_lossy(v: &Value) -> Vec<u8> {
    String::from_utf16_lossy(&units_of(v)).into_bytes()
}

fn b64_type_error(received: &str) -> String {
    format!(
        "The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received {received}"
    )
}

fn object_label(v: &Value) -> &'static str {
    let Some(o) = v.as_object() else {
        return "an instance of Object";
    };
    if o.len() != 1 {
        return "an instance of Object";
    }
    if o.contains_key("$map") {
        "an instance of Map"
    } else if o.contains_key("$set") {
        "an instance of Set"
    } else if o.contains_key("$date") {
        "an instance of Date"
    } else {
        "an instance of Object"
    }
}

fn buffer_bytes(v: &Value) -> Result<Vec<u8>, String> {
    match v {
        _ if js::string_units(v).is_some() => Ok(string_bytes_lossy(v)),
        Value::Array(items) => Ok(items.iter().map(to_uint8).collect()),
        Value::Object(o) if o.len() == 1 => {
            if let Some(bytes) = o.get("$bytes").and_then(Value::as_array) {
                return Ok(bytes.iter().map(to_uint8).collect());
            }
            if let Some(bytes) = o.get("$buffer").and_then(Value::as_array) {
                return Ok(bytes.iter().map(to_uint8).collect());
            }
            if is_undef(v) {
                return Err(b64_type_error("undefined"));
            }
            Err(b64_type_error(object_label(v)))
        }
        Value::Null => Err(b64_type_error("null")),
        Value::Bool(b) => Err(b64_type_error(&format!("type boolean ({b})"))),
        Value::Number(_) => Err(b64_type_error(&format!(
            "type number ({})",
            js::number_to_string(js::as_number(v).unwrap_or(f64::NAN))
        ))),
        _ => Err(b64_type_error(object_label(v))),
    }
}

fn to_uint8(v: &Value) -> u8 {
    let n = to_num(v);
    if !n.is_finite() {
        return 0;
    }
    n.trunc().rem_euclid(256.0) as u8
}

const ENC_MASK: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";

fn encode_uri_component(v: &Value) -> Result<String, String> {
    let s = match String::from_utf16(&units_of(v)) {
        Ok(s) => s,
        Err(_) => return Err("URIError: URI malformed".into()),
    };
    let mut out = String::new();
    for b in s.into_bytes() {
        let c = b as char;
        if c.is_ascii() && ENC_MASK.contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    Ok(out)
}

// ── Number → base-36 (V8 DoubleToRadixCString) ─────────────────────────────────────────────────

fn frac_radix_digits(x: f64) -> (f64, Vec<u8>) {
    const RADIX: f64 = 36.0;
    let mut fraction = x;
    let mut delta = 0.5 * (x.next_up() - x).max(0.0);
    let min_pos = f64::from_bits(1);
    if delta < min_pos {
        delta = min_pos;
    }
    let mut integer: f64 = 0.0;
    let mut digits: Vec<u8> = Vec::new();
    if fraction >= delta {
        loop {
            fraction *= RADIX;
            delta *= RADIX;
            let digit = fraction as u32;
            digits.push(digit as u8);
            fraction -= f64::from(digit);
            if (fraction > 0.5 || (fraction == 0.5 && digit % 2 == 1)) && fraction + delta > 1.0 {
                let carry = loop {
                    match digits.pop() {
                        Some(d) if d + 1 < 36 => {
                            digits.push(d + 1);
                            break false;
                        }
                        Some(_) => {}
                        None => break true,
                    }
                };
                if carry {
                    integer += 1.0;
                }
                break;
            }
            if fraction.partial_cmp(&delta) != Some(std::cmp::Ordering::Greater)
                && fraction.partial_cmp(&delta) != Some(std::cmp::Ordering::Equal)
            {
                break;
            }
        }
    }
    (integer, digits)
}

fn number_radix_string36(x: f64) -> String {
    if x == 0.0 {
        return "0".to_string();
    }
    if x.fract() == 0.0 {
        let mut n = x as i128;
        let neg = n < 0;
        if neg {
            n = -n;
        }
        let mut rev = Vec::new();
        while n > 0 {
            rev.push(std::char::from_digit((n % 36) as u32, 36).unwrap_or('0')); // INFALLIBLE: digit < 36
            n /= 36;
        }
        let mut s: String = rev.into_iter().rev().collect();
        if neg {
            s.insert(0, '-');
        }
        return s;
    }
    let (integer, digits) = frac_radix_digits(x);
    let mut out = String::new();
    out.push_str(&number_radix_string36(integer));
    if !digits.is_empty() {
        out.push('.');
        for d in digits {
            out.push(std::char::from_digit(u32::from(d), 36).unwrap_or('0')); // INFALLIBLE: digit < 36
        }
    }
    out
}

// ── URL hostname (WHATWG approximation) ────────────────────────────────────────────────────────

const SPECIAL: [&str; 6] = ["http", "https", "ws", "wss", "ftp", "file"];

fn parse_url_hostname(url: &str) -> Result<String, ()> {
    let cleaned: String = url
        .chars()
        .filter(|c| !matches!(*c, '\t' | '\n' | '\r'))
        .collect();
    let cleaned = trimmed_of_controls(cleaned.as_str());
    let Some(colon) = cleaned.find(':') else {
        return Err(());
    };
    let scheme = &cleaned[..colon];
    if scheme.is_empty()
        || !scheme
            .bytes()
            .all(|b| b.is_ascii_alphabetic() || matches!(b, b'+' | b'-' | b'.'))
    {
        return Err(());
    }
    let scheme_l = scheme.to_ascii_lowercase();
    let rest = &cleaned[colon + 1..];
    if SPECIAL.contains(&scheme_l.as_str()) {
        let rest = if let Some(r) = rest.strip_prefix("//") {
            r.to_string()
        } else {
            rest.to_string()
        };
        return authority_host(&rest, &scheme_l);
    }
    if let Some(r) = rest.strip_prefix("//") {
        return authority_host_opaque(r);
    }
    Ok(String::new())
}

fn trimmed_of_controls(s: &str) -> &str {
    s.trim_start_matches(|c: char| (c as u32) < 0x20 || c == ' ')
        .trim_end_matches(|c: char| (c as u32) < 0x20 || c == ' ')
}

fn split_authority(rest: &str) -> Result<(String, &str), ()> {
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    Ok((rest[..end].to_string(), &rest[..end]))
}

fn authority_host(rest: &str, scheme: &str) -> Result<String, ()> {
    let (authority, _) = split_authority(rest)?;
    let after_user = match authority.rfind('@') {
        Some(at) => &authority[at + 1..],
        None => authority.as_str(),
    };
    let (host_part, port) = split_host_port(after_user)?;
    if let Some(port) = port.filter(|p| !p.is_empty()) {
        {
            let p: u64 = port.parse().map_err(|_| ())?;
            if p > 65535 {
                return Err(());
            }
        }
    }
    if host_part.starts_with('[') {
        return ipv6_host(host_part);
    }
    if host_part.is_empty() {
        if scheme != "file" {
            return Err(());
        }
        return Ok(String::new());
    }
    domain_host(host_part)
}

fn authority_host_opaque(rest: &str) -> Result<String, ()> {
    let (authority, _) = split_authority(rest)?;
    let after_user = match authority.rfind('@') {
        Some(at) => &authority[at + 1..],
        None => authority.as_str(),
    };
    let (host_part, _) = split_host_port(after_user)?;
    if host_part.chars().any(forbidden_host_char) {
        return Err(());
    }
    Ok(host_part.to_string())
}

fn split_host_port(s: &str) -> Result<(&str, Option<&str>), ()> {
    if s.starts_with('[') {
        let close = s.find(']').ok_or(())?;
        let (host, tail) = s.split_at(close + 1);
        if tail.is_empty() {
            return Ok((host, None));
        }
        let port = tail.strip_prefix(':').ok_or(())?;
        return Ok((host, Some(port)));
    }
    match s.rfind(':') {
        Some(i) => Ok((&s[..i], Some(&s[i + 1..]))),
        None => Ok((s, None)),
    }
}

fn forbidden_host_char(c: char) -> bool {
    matches!(
        c,
        '\0' | '\t'
            | '\n'
            | '\r'
            | ' '
            | '#'
            | '/'
            | ':'
            | '<'
            | '>'
            | '?'
            | '@'
            | '['
            | '\\'
            | ']'
            | '^'
            | '|'
            | '%'
    )
}

fn forbidden_domain_char(c: char) -> bool {
    forbidden_host_char(c) || (c as u32) < 0x20 || c == '\u{007F}'
}

fn domain_host(host: &str) -> Result<String, ()> {
    let decoded = String::from_utf8_lossy(&percent_decode(host)).into_owned();
    if decoded.is_empty() {
        return Err(());
    }
    if decoded.chars().any(forbidden_domain_char) {
        return Err(());
    }
    if ends_in_number(&decoded) {
        return ipv4_host(&decoded);
    }
    let mut out = String::with_capacity(decoded.len());
    for (i, label) in decoded.split('.').enumerate() {
        if i > 0 {
            out.push('.');
        }
        if label.bytes().all(|b| b.is_ascii()) {
            out.push_str(&label.to_ascii_lowercase());
        } else {
            out.push_str(&format!("xn--{}", punycode_encode(&label.to_lowercase())?));
        }
    }
    Ok(out)
}

fn percent_decode(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("x"); // INFALLIBLE: slice of valid UTF-8 stays valid
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn ipv4_number(input: &str) -> Option<u64> {
    if let Some(rest) = input
        .strip_prefix("0x")
        .or_else(|| input.strip_prefix("0X"))
    {
        return radix_value(rest, 16, true);
    }
    if input.len() > 1 && input.starts_with('0') {
        return radix_value(&input[1..], 8, true);
    }
    radix_value(input, 10, false)
}

fn radix_value(digits: &str, radix: u32, allow_empty: bool) -> Option<u64> {
    if digits.is_empty() {
        return if allow_empty { Some(0) } else { None };
    }
    let mut value: u64 = 0;
    for c in digits.chars() {
        let d = c.to_digit(radix)?;
        value = value
            .checked_mul(u64::from(radix))?
            .checked_add(u64::from(d))?;
        if value > u64::from(u32::MAX) {
            return None;
        }
    }
    Some(value)
}

fn ends_in_number(host: &str) -> bool {
    let mut parts: Vec<&str> = host.split('.').collect();
    if parts.len() > 1 && parts.last().is_some_and(|p| p.is_empty()) {
        parts.pop();
    }
    parts
        .last()
        .is_some_and(|p| !p.is_empty() && ipv4_number(p).is_some())
}

fn ipv4_host(host: &str) -> Result<String, ()> {
    let mut parts: Vec<&str> = host.split('.').collect();
    if parts.len() > 1 && parts.last().is_some_and(|p| p.is_empty()) {
        parts.pop();
    }
    if parts.is_empty() || parts.len() > 4 {
        return Err(());
    }
    let len = parts.len();
    let mut bytes: Vec<u64> = Vec::with_capacity(len);
    for (i, part) in parts.iter().enumerate() {
        let n = ipv4_number(part).ok_or(())?;
        if i + 1 < len {
            if n >= 256 {
                return Err(());
            }
        } else if n >= 256u64.pow(5 - len as u32) {
            return Err(());
        }
        bytes.push(n);
    }
    let mut value: u64 = 0;
    for b in bytes {
        value = value * 256 + b;
    }
    Ok(format!(
        "{}.{}.{}.{}",
        (value >> 24) & 255,
        (value >> 16) & 255,
        (value >> 8) & 255,
        value & 255
    ))
}

fn ipv6_host(host: &str) -> Result<String, ()> {
    let inner = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .ok_or(())?;
    if inner.is_empty() {
        return Err(());
    }
    let mut head: Vec<u16> = Vec::new();
    let mut tail: Vec<u16> = Vec::new();
    let mut compressed = false;
    let mut seen_piece = false;
    for piece in inner.split(':') {
        if piece.is_empty() {
            if seen_piece && !tail.is_empty() {
                return Err(());
            }
            if compressed {
                return Err(());
            }
            compressed = true;
            continue;
        }
        seen_piece = true;
        let v = u16::from_str_radix(piece, 16).map_err(|_| ())?;
        if compressed {
            tail.push(v);
        } else {
            head.push(v);
        }
    }
    if head.len() + tail.len() > 8 {
        return Err(());
    }
    if !compressed && head.len() + tail.len() != 8 {
        return Err(());
    }
    let mut groups = head;
    groups.resize(8 - tail.len(), 0);
    groups.extend_from_slice(&tail);
    let (best_start, best_len) = {
        let (mut s, mut l) = (usize::MAX, 0);
        let mut i = 0;
        while i < 8 {
            if groups[i] == 0 {
                let start = i;
                while i < 8 && groups[i] == 0 {
                    i += 1;
                }
                if i - start > l {
                    l = i - start;
                    s = start;
                }
            } else {
                i += 1;
            }
        }
        (s, l)
    };
    let mut out = String::from("[");
    let mut g = 0;
    while g < 8 {
        if g == best_start && best_len > 1 {
            if out != "[" && !out.ends_with(':') {
                out.push(':');
            }
            out.push_str("::");
            g += best_len;
            continue;
        }
        if g > 0 && !out.ends_with(':') {
            out.push(':');
        }
        out.push_str(&format!("{:x}", groups[g]));
        g += 1;
    }
    out.push(']');
    Ok(out)
}

const PUNY_BASE: u32 = 36;
const PUNY_TMIN: u32 = 1;
const PUNY_TMAX: u32 = 26;
const PUNY_SKEW: u32 = 38;
const PUNY_DAMP: u32 = 700;
const PUNY_INITIAL_BIAS: u32 = 72;
const PUNY_INITIAL_N: u32 = 128;

fn puny_adapt(delta: u32, numpoints: u32, firsttime: bool) -> u32 {
    let mut delta = if firsttime {
        delta / PUNY_DAMP
    } else {
        delta / 2
    };
    delta += delta / numpoints;
    let mut k = 0;
    while delta > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) / 2 {
        delta /= PUNY_BASE - PUNY_TMIN;
        k += PUNY_BASE;
    }
    k + (((PUNY_BASE - PUNY_TMIN + 1) * delta) / (delta + PUNY_SKEW))
}

fn digit_char(d: u32) -> char {
    std::char::from_digit(d, 36).unwrap_or('0') // INFALLIBLE: digit < 36
}

fn punycode_encode(label: &str) -> Result<String, ()> {
    let chars: Vec<u32> = label.chars().map(u32::from).collect();
    let mut output: Vec<char> = chars
        .iter()
        .filter(|c| **c < 128)
        .filter_map(|c| char::from_u32(*c))
        .collect();
    let b = output.len() as u32;
    let mut h = b;
    if b > 0 {
        output.push('-');
    }
    let mut n = PUNY_INITIAL_N;
    let mut bias = PUNY_INITIAL_BIAS;
    let mut delta: u32 = 0;
    let total = chars.len() as u32;
    while h < total {
        let m = chars.iter().filter(|c| **c >= n).min().copied().ok_or(())?;
        delta = delta
            .checked_add((m - n).checked_mul(h + 1).ok_or(())?)
            .ok_or(())?;
        n = m;
        for cp in chars.clone() {
            if cp < n {
                delta = delta.checked_add(1).ok_or(())?;
            }
            if cp == n {
                let mut q = delta;
                let mut k = PUNY_BASE;
                loop {
                    let t = if k <= bias {
                        PUNY_TMIN
                    } else if k >= bias + PUNY_TMAX {
                        PUNY_TMAX
                    } else {
                        k - bias
                    };
                    if q < t {
                        break;
                    }
                    output.push(digit_char(t + ((q - t) % (PUNY_BASE - t))));
                    q = (q - t) / (PUNY_BASE - t);
                    k += PUNY_BASE;
                }
                output.push(digit_char(q));
                bias = puny_adapt(delta, h + 1, h == b);
                delta = 0;
                h += 1;
            }
        }
        delta += 1;
        n = n.checked_add(1).ok_or(())?;
    }
    Ok(output.into_iter().collect())
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

enum CsvItem {
    Unit(u16),
    Val(Value),
}

impl CsvItem {
    fn is(&self, c: u16) -> bool {
        match self {
            CsvItem::Unit(u) => *u == c,
            CsvItem::Val(v) => {
                v == &Value::String(
                    (char::from_u32(u32::from(c)).unwrap_or('\u{FFFD}')).to_string(),
                )
            }
        }
    }
}

fn string_data(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Object(_) => js::string_units(v).map(|u| String::from_utf16_lossy(&u)),
        _ => None,
    }
}

fn row_filter_keep(row: &[Value]) -> bool {
    row.iter().any(|c| {
        let s = if is_nullish(c) {
            String::new()
        } else {
            js_str(c)
        };
        !js_trim(&s).is_empty()
    })
}

pub fn parse_csv_rows(text: Value) -> Result<Value, String> {
    let items: Vec<CsvItem> = match &text {
        Value::Null => return Err("Cannot read properties of null (reading 'length')".to_string()),
        v if is_undef(v) => {
            return Err("Cannot read properties of undefined (reading 'length')".to_string());
        }
        Value::Array(a) => a.iter().cloned().map(CsvItem::Val).collect(),
        Value::String(_) => js::string_units(&text)
            .unwrap_or_default()
            .into_iter()
            .map(CsvItem::Unit)
            .collect(),
        Value::Object(_) => match js::string_units(&text) {
            Some(units) => units.into_iter().map(CsvItem::Unit).collect(),
            None => return Ok(json!([])),
        },
        _ => return Ok(json!([])),
    };
    let quote = u16::from(b'"');
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut row: Vec<Value> = Vec::new();
    let mut cell: Vec<u16> = Vec::new();
    let push_cell = |cell: &Vec<u16>, row: &mut Vec<Value>| {
        row.push(Value::String(String::from_utf16_lossy(cell)));
    };
    let mut quoted = false;
    let mut i = 0usize;
    while i < items.len() {
        let item = &items[i];
        if quoted {
            if item.is(quote) {
                if items.get(i + 1).is_some_and(|p| p.is(quote)) {
                    cell.push(quote);
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                match item {
                    CsvItem::Unit(u) => cell.push(*u),
                    CsvItem::Val(v) => cell.extend(js_str(v).encode_utf16()),
                }
            }
            i += 1;
            continue;
        }
        if item.is(quote) {
            quoted = true;
        } else if item.is(u16::from(b',')) {
            push_cell(&cell, &mut row);
            cell.clear();
        } else if item.is(u16::from(b'\n')) {
            push_cell(&cell, &mut row);
            rows.push(std::mem::take(&mut row));
            cell.clear();
        } else if item.is(u16::from(b'\r')) {
        } else {
            match item {
                CsvItem::Unit(u) => cell.push(*u),
                CsvItem::Val(v) => cell.extend(js_str(v).encode_utf16()),
            }
        }
        i += 1;
    }
    if !cell.is_empty() || !row.is_empty() {
        push_cell(&cell, &mut row);
        rows.push(row);
    }
    rows.retain(|r| row_filter_keep(r));
    Ok(json!(rows))
}

// ─── Host / emails ───────────────────────────────────────────────────────────

fn has_scheme_prefix(raw: &str) -> bool {
    match raw.find("://") {
        Some(idx) => idx > 0 && raw[..idx].bytes().all(|b| b.is_ascii_alphabetic()),
        None => false,
    }
}

fn strip_www(host: &str) -> String {
    let b = host.as_bytes();
    if b.len() >= 4
        && (b[0] | 0x20) == b'w'
        && (b[1] | 0x20) == b'w'
        && (b[2] | 0x20) == b'w'
        && b[3] == b'.'
    {
        host[4..].to_string()
    } else {
        host.to_string()
    }
}

pub fn normalize_host(input: Value) -> Result<Value, String> {
    let raw = if truthy(&input) {
        js_trim_owned(&js_str(&input))
    } else {
        String::new()
    };
    if raw.is_empty() {
        return Ok(json!(""));
    }
    let with_scheme = if has_scheme_prefix(&raw) || raw.starts_with("//") {
        raw.clone()
    } else {
        format!("https://{raw}")
    };
    let host = parse_url_hostname(&with_scheme).unwrap_or_default();
    Ok(json!(strip_www(&host).to_lowercase()))
}

fn re_email() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}").unwrap() // INFALLIBLE: fixed pattern
    })
}

pub fn extract_emails(value: Value) -> Result<Value, String> {
    if !truthy(&value) {
        return Ok(json!([]));
    }
    let original_string = string_data(&value);
    let mut list = value;
    if let Some(s) = original_string.filter(|v| js_trim(v).starts_with('['))
        && let Ok(parsed) = serde_json::from_str::<Value>(&s)
    {
        list = parsed;
    }
    let text = js_str(&list);
    let mut out: Vec<Value> = Vec::new();
    for m in re_email().find_iter(&text) {
        let e = m.as_str().to_lowercase();
        if out.iter().all(|x| x.as_str() != Some(e.as_str())) {
            out.push(json!(e));
        }
    }
    Ok(Value::Array(out))
}

fn csv_num(v: &Value) -> Value {
    let s0 = if is_nullish(v) {
        String::new()
    } else {
        js_str(v)
    };
    let n = js_num_from_str(&s0.replacen(',', ".", 1));
    if n.is_finite() { json!(n) } else { Value::Null }
}

// ─── Header / row access ─────────────────────────────────────────────────────

fn header_from(header: &Value) -> Result<HashMap<String, usize>, String> {
    match header {
        Value::Null => Err("Cannot read properties of null (reading 'get')".to_string()),
        v if is_undef(v) => Err("Cannot read properties of undefined (reading 'get')".to_string()),
        Value::Object(o) => {
            let Some(entries) = o.get("$map").and_then(Value::as_array) else {
                return Err("header.get is not a function".to_string());
            };
            let mut map = HashMap::new();
            for e in entries {
                let Some(pair) = e.as_array() else { continue };
                if pair.is_empty() {
                    continue;
                }
                let key = match &pair[0] {
                    Value::String(s) => s.clone(),
                    other => js_str(other),
                };
                let idx_v = pair.get(1).cloned().unwrap_or(undef());
                let idx_n = to_num(&idx_v);
                if idx_n.is_finite() && idx_n >= 0.0 {
                    map.insert(key, idx_n as usize);
                }
            }
            Ok(map)
        }
        _ => Err("header.get is not a function".to_string()),
    }
}

fn index_get(v: &Value, key: &str) -> Result<Value, String> {
    match v {
        Value::Null => Err(format!("Cannot read properties of null (reading '{key}')")),
        _ if is_undef(v) => Err(format!(
            "Cannot read properties of undefined (reading '{key}')"
        )),
        Value::Array(items) => Ok(array_get(items, key).cloned().unwrap_or(undef())),
        Value::Object(_) => {
            if let Some(units) = js::string_units(v) {
                return Ok(canonical_index(key)
                    .and_then(|i| units.get(i).copied())
                    .map_or_else(undef, |u| js::utf16_string(&[u])));
            }
            Ok(v.get(key).cloned().unwrap_or(undef()))
        }
        _ => Ok(undef()),
    }
}

fn row_get(row: &Value, idx: usize) -> Result<Value, String> {
    index_get(row, &idx.to_string())
}

fn lead_get(
    row: &Value,
    header: &HashMap<String, usize>,
    names: &[&str],
) -> Result<String, String> {
    for name in names {
        let Some(idx) = header.get(*name) else {
            continue;
        };
        let cell = row_get(row, *idx)?;
        if is_nullish(&cell) {
            continue;
        }
        let s = js_trim_owned(&js_str(&cell));
        if !s.is_empty() {
            return Ok(s);
        }
    }
    Ok(String::new())
}

fn lead_from_row_inner(row: &Value, header: &HashMap<String, usize>) -> Result<Value, String> {
    let name = lead_get(row, header, &["title", "name", "business_name"])?;
    let phone = lead_get(row, header, &["phone", "phoneNumber", "phone_number"])?;
    let mut address = lead_get(
        row,
        header,
        &["address", "full_address", "complete_address"],
    )?;
    if address.is_empty() {
        let parts: Vec<String> = [
            lead_get(row, header, &["neighborhood"])?,
            lead_get(row, header, &["street"])?,
            lead_get(row, header, &["city"])?,
            lead_get(row, header, &["postal_code"])?,
        ]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect();
        address = parts.join(", ");
    }
    if name.is_empty() {
        return Ok(Value::Null);
    }
    let emails_v = lead_get(row, header, &["emails", "email"])?;
    let emails = extract_emails(json!(emails_v))?;
    let rating = csv_num(&json!(lead_get(
        row,
        header,
        &["review_rating", "rating", "reviews_stars"]
    )?));
    let count = csv_num(&json!(lead_get(
        row,
        header,
        &["review_count", "reviews", "reviews_count"]
    )?));
    let mut out = Map::new();
    out.insert("id".into(), json!(""));
    out.insert("name".into(), json!(name));
    out.insert("phone".into(), json!(phone));
    out.insert("emails".into(), emails);
    out.insert(
        "website".into(),
        json!(lead_get(row, header, &["website", "site", "url"])?),
    );
    out.insert(
        "category".into(),
        json!(lead_get(row, header, &["category", "type", "categories"])?),
    );
    out.insert("address".into(), json!(address));
    out.insert("reviewRating".into(), rating);
    out.insert("reviewCount".into(), count);
    out.insert(
        "telegram".into(),
        json!(lead_get(row, header, &["telegram"])?),
    );
    out.insert(
        "facebook".into(),
        json!(lead_get(row, header, &["facebook"])?),
    );
    out.insert(
        "instagram".into(),
        json!(lead_get(row, header, &["instagram"])?),
    );
    out.insert(
        "sourceQuery".into(),
        json!(lead_get(row, header, &["query", "search", "input_id"])?),
    );
    out.insert("createdAt".into(), json!(iso_string(pinned::now_ms())));
    Ok(Value::Object(out))
}

pub fn lead_from_row(row: Value, header: Value) -> Result<Value, String> {
    let map = header_from(&header)?;
    lead_from_row_inner(&row, &map)
}

pub fn import_rows(text: Value) -> Result<Value, String> {
    let rows_v = parse_csv_rows(text)?;
    let rows = rows_v.as_array().cloned().unwrap_or_default();
    if rows.is_empty() {
        return Ok(json!({"leads": [], "skipped": 0}));
    }
    let mut header: HashMap<String, usize> = HashMap::new();
    let header_row = rows[0].as_array().cloned().unwrap_or_default();
    for (i, name_v) in header_row.iter().enumerate() {
        let name = match name_v {
            Value::Null => {
                return Err("Cannot read properties of null (reading 'trim')".to_string());
            }
            x if is_undef(x) => {
                return Err("Cannot read properties of undefined (reading 'trim')".to_string());
            }
            Value::String(s) => js_trim(s).to_lowercase(),
            _ => return Err("name.trim is not a function".to_string()),
        };
        header.insert(name, i);
    }
    let mut leads: Vec<Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut skipped: u64 = 0;
    for row in rows.iter().skip(1) {
        let cells = row.as_array().cloned().unwrap_or_default();
        let first = cells.first().cloned().unwrap_or(undef());
        if cells.len() < 2 && !truthy(&first) {
            skipped += 1;
            continue;
        }
        let lead = lead_from_row_inner(row, &header)?;
        if is_nullish(&lead) {
            skipped += 1;
            continue;
        }
        let name_v = prop(&lead, "name").unwrap_or(undef());
        let phone_v = prop(&lead, "phone").unwrap_or(undef());
        let host = js_str(&normalize_host(prop(&lead, "website").unwrap_or(undef()))?);
        let key = if !host.is_empty() {
            host
        } else {
            format!("{}|{}", js_str(&name_v).to_lowercase(), js_str(&phone_v))
        };
        if key.is_empty() || seen.contains(&key) {
            skipped += 1;
            continue;
        }
        seen.insert(key);
        leads.push(lead);
    }
    Ok(json!({"leads": leads, "skipped": skipped}))
}

// ─── Scan / routes ───────────────────────────────────────────────────────────

const WS_CLASS: &str = "[\\t\\n\\u{000B}\\u{000C}\\r \\u{00A0}\\u{1680}\\u{2000}-\\u{200A}\\u{2028}\\u{2029}\\u{202F}\\u{205F}\\u{3000}\\u{FEFF}]";

fn re_whats() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)wa\.me|api\.whatsapp\.com|whatsapp\.com|chat\.whatsapp").unwrap() // INFALLIBLE: fixed pattern
    })
}

fn re_tel() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r#"(?i)href=["']tel:"#).unwrap()) // INFALLIBLE: fixed pattern
}

fn re_form() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)<form($|[^A-Za-z0-9_])").unwrap()) // INFALLIBLE: fixed pattern
}

fn re_mail() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r#"(?i)href=["']mailto:"#).unwrap()) // INFALLIBLE: fixed pattern
}

fn re_viewport() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(&format!(
            r#"(?i)<meta[^>]+viewport[^>]+width{0}*={0}*device-width"#,
            WS_CLASS
        ))
        .unwrap() // INFALLIBLE: fixed pattern
    })
}

fn re_lang() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r#"(?i)<html[^>]*[^A-Za-z0-9_]lang=["']([^"']+)["']"#).unwrap() // INFALLIBLE: fixed pattern
    })
}

pub fn scan_conversion(html: Value, final_url: Value) -> Result<Value, String> {
    let text = if truthy(&html) {
        js_str(&html)
    } else {
        String::new()
    };
    let fu = if truthy(&final_url) {
        js_str(&final_url)
    } else {
        String::new()
    };
    let lang = re_lang()
        .captures(&text)
        .and_then(|c| c.get(1))
        .map_or_else(String::new, |m| m.as_str().to_string());
    Ok(json!({
        "https": fu.to_lowercase().starts_with("https:"),
        "hasWhats": re_whats().is_match(&text),
        "hasTel": re_tel().is_match(&text),
        "hasForm": re_form().is_match(&text),
        "hasEmail": re_mail().is_match(&text),
        "viewport": re_viewport().is_match(&text),
        "lang": lang,
    }))
}

const HTTPS_POINT: &str =
    "Site HTTPS değil; tarayıcı 'güvenli değil' uyarısı ile ziyaretçiyi kaybediyor.";
const HTTPS_FIX: &str = "TLS sertifikası kurun (Cloudflare/Let's Encrypt, ücretsiz).";
const CONTACT_POINT: &str = "Tek dokunuşla iletişim yok: ne WhatsApp ne de tıklanabilir telefon bağlantısı var; ilgilenen ziyaretçi iletişim kurmadan çıkıyor.";
const CONTACT_FIX: &str = "Her sayfada tek dokunuşla WhatsApp ve arama bağlantısı.";
const TEL_POINT: &str = "Telefon bağlantısı yok; WhatsApp'tan görmeyen ziyaretçi arama yapamıyor.";
const TEL_FIX: &str = "tıkla-ara (tel:) bağlantısı ekleyin.";
const FORM_POINT: &str = "İletişim formu yok; gelen ziyaretçiyi kaydetmenin yolu yok.";
const FORM_FIX: &str = "Doğrulamalı bir iletişim formu ekleyin.";
const VIEWPORT_POINT: &str = "Mobil görünüm ayarı (viewport) eksik; telefon açan müşteri yatay kaydırma ile uğraşıyor ve çıkıyor.";
const VIEWPORT_FIX: &str = "Duyarlı (mobile-first) tasarım.";

fn is_false(v: &Value) -> bool {
    v == &Value::Bool(false)
}

pub fn loss_points(analysis: Value) -> Result<Value, String> {
    let conv_v = prop(&analysis, "conversion")?;
    let conv = if truthy(&conv_v) { conv_v } else { json!({}) };
    let recs_v = prop(&analysis, "recommendations")?;
    let recs = if truthy(&recs_v) { recs_v } else { json!([]) };
    let Some(rec_arr) = recs.as_array() else {
        return Err("analysis.recommendations.filter is not a function".to_string());
    };
    let mut out: Vec<Value> = Vec::new();
    for r in rec_arr {
        let sev_v = prop(r, "severity")?;
        let sev = match &sev_v {
            Value::String(s) => s.as_str(),
            _ => "",
        };
        if sev != "critical" && sev != "high" {
            continue;
        }
        let title_v = prop(r, "title")?;
        let evidence_v = prop(r, "evidence")?;
        let point = format!(
            "{}: {}",
            js_str(&title_v),
            if truthy(&evidence_v) {
                js_str(&evidence_v)
            } else {
                String::new()
            }
        );
        let point = js_trim(&re_ws_plus().replace_all(&point, " ")).to_string();
        let fix_v = prop(r, "fix")?;
        let fix = if truthy(&fix_v) { fix_v } else { json!("") };
        out.push(json!({"point": point, "fix": fix}));
    }
    let https_v = prop(&conv, "https")?;
    if is_false(&https_v) {
        out.push(json!({"point": HTTPS_POINT, "fix": HTTPS_FIX}));
    }
    let whats_v = prop(&conv, "hasWhats")?;
    let tel_v = prop(&conv, "hasTel")?;
    if is_false(&whats_v) && is_false(&tel_v) {
        out.push(json!({"point": CONTACT_POINT, "fix": CONTACT_FIX}));
    }
    if is_false(&tel_v) && whats_v == Value::Bool(true) {
        out.push(json!({"point": TEL_POINT, "fix": TEL_FIX}));
    }
    if is_false(&prop(&conv, "hasForm")?) {
        out.push(json!({"point": FORM_POINT, "fix": FORM_FIX}));
    }
    if is_false(&prop(&conv, "viewport")?) {
        out.push(json!({"point": VIEWPORT_POINT, "fix": VIEWPORT_FIX}));
    }
    Ok(Value::Array(out))
}

fn has_blocking(recs: &Value) -> Result<bool, String> {
    let Some(arr) = recs.as_array() else {
        return Err("analysis.recommendations.some is not a function".to_string());
    };
    for r in arr {
        let sev_v = prop(r, "severity")?;
        let sev = match &sev_v {
            Value::String(s) => s.as_str(),
            _ => "",
        };
        if sev == "critical" || sev == "high" {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn choose_route(lead: Value, analysis: Value) -> Result<Value, String> {
    let website = prop(&lead, "website")?;
    if !truthy(&website) {
        return Ok(json!("no-site"));
    }
    if is_nullish(&analysis) {
        return Ok(json!("unreachable"));
    }
    if truthy(&prop(&analysis, "unreachable")?) {
        return Ok(json!("unreachable"));
    }
    let recs_v = prop(&analysis, "recommendations")?;
    let recs = if truthy(&recs_v) { recs_v } else { json!([]) };
    let blocking = has_blocking(&recs)?;
    let score = prop(&analysis, "score")?;
    if to_num(&score) >= 85.0 && !blocking {
        return Ok(json!("ai-visibility"));
    }
    Ok(json!("fix"))
}

pub fn top_issues(analysis: Value, route: Value) -> Result<Value, String> {
    if route == json!("unreachable") {
        return Ok(
            json!([{"point": "Site açılmıyor", "fix": "Alan adı, DNS ve sunucu ayarlarını kontrol edin."}]),
        );
    }
    let points = loss_points(analysis)?;
    let arr = points.as_array().cloned().unwrap_or_default();
    Ok(Value::Array(arr.into_iter().take(4).collect()))
}

// ─── Draft ───────────────────────────────────────────────────────────────────

const SITE_URL: &str = "https://ai-ulu.com";
const SITE_EMAIL: &str = "aliulu@ai-ulu.com";
const WHATSAPP: &str = "https://wa.me/905079581642";
const CHECKUP: &str = "https://ai-ulu.com/checkup/";

fn city_of(lead: &Value) -> Result<String, String> {
    let address_v = prop(lead, "address")?;
    let address = if truthy(&address_v) {
        js_str(&address_v)
    } else {
        String::new()
    };
    let parts: Vec<String> = address
        .split(',')
        .map(js_trim_owned)
        .filter(|s| !s.is_empty())
        .collect();
    if parts.len() > 1 {
        Ok(parts.get(parts.len() - 2).cloned().unwrap_or_default())
    } else {
        Ok(parts.first().cloned().unwrap_or_default())
    }
}

pub fn build_draft(lead: Value, analysis: Value, route_arg: Value) -> Result<Value, String> {
    let route_s = if truthy(&route_arg) {
        js_str(&route_arg)
    } else {
        js_str(&choose_route(lead.clone(), analysis.clone())?)
    };
    let city = city_of(&lead)?;
    let emails_v = prop(&lead, "emails")?;
    let email0 = index_get(&emails_v, "0")?;
    let phone_v = prop(&lead, "phone")?;
    let contact = if truthy(&email0) {
        email0.clone()
    } else if truthy(&phone_v) {
        phone_v.clone()
    } else {
        json!("")
    };
    let name_v = prop(&lead, "name")?;
    let name_str = if truthy(&name_v) {
        js_str(&name_v)
    } else {
        String::new()
    };
    let first = re_ws_plus()
        .split(name_str.as_str())
        .next()
        .unwrap_or("")
        .to_string();
    let name_raw = js_str(&name_v);
    let call_text = format!("Merhaba, {} için görüşme talep ediyorum.", js_str(&name_v));
    let call = format!(
        "{WHATSAPP}?text={}",
        encode_uri_component(&json!(call_text))?
    );
    let intro = if !city.is_empty() {
        format!("Merhaba {first}, {city} içindeki kaydınızı görürken sitenize baktım.")
    } else {
        format!("Merhaba {first}, kaydınızı görürken sitenize baktım.")
    };
    let footer = format!("\n\nAli Ulu — ai-ulu\n{SITE_URL} · {SITE_EMAIL}");

    let (subject, body);
    if route_s == "no-site" {
        let city_sfx = if !city.is_empty() {
            format!(" ({city})")
        } else {
            String::new()
        };
        subject = format!(
            "{} için müşteri getiren bir web sitesi{}",
            js_str(&name_v),
            city_sfx
        );
        let rc_v = prop(&lead, "reviewCount")?;
        let rr_v = prop(&lead, "reviewRating")?;
        let reputation = if truthy(&rc_v) {
            let stars = if truthy(&rr_v) {
                format!(" ve puanınız {}★", js_str(&rr_v))
            } else {
                String::new()
            };
            format!(
                "; {} yorumluk gerçek bir itibarınız var{}",
                js_str(&rc_v),
                stars
            )
        } else {
            String::new()
        };
        let phone_line = if truthy(&phone_v) {
            format!("\nTelefon: {}", js_str(&phone_v))
        } else {
            String::new()
        };
        body = format!(
            "{intro}\n\nGoogle Haritalar'da {name_raw} karşısıma çıktı{reputation}. Ama sizi bulan biri \
             sizinle iletişim kurabileceği bir web sayfası göremiyor ve bu araştırmayı yapan \
             müşteriyi rakibinize kaydırıyor.\n\nai-ulu olarak yaptığımız iş tek cümlede: sıfırdan \
             tasarlanan, Google'da ve ChatGPT/Gemini gibi yapay zekâ aramalarında bulunan, tek \
             dokunuşla WhatsApp'a bağlanan siteler.\n\n  • Özgün tasarım — hazır şablon değil, \
             işletmenize göre kodlanır\n  • Teknik SEO + yapay zekâ görünürlüğü ilk günden \
             dahil\n  • Her sayfada tek dokunuşla WhatsApp ve arama\n  • Alan adı ve kod sizden; \
             yayından sonra ölçer, düzeltiriz\n\nÜcretsiz 30 dakikalık görüşmede hedefi konuşur, \
             ilk haftadan tıklanabilir önizleme veririz. Görüşmeden sonra 24 saat içinde yazılı \
             teklif; tanıtım siteleri 5.000 ₺'den başlar.\n\nUygun olduğunuz kısa bir zaman varsa \
             buradan yazmanız yeterli: {call}{phone_line}{footer}"
        );
    } else if route_s == "unreachable" {
        let err_v = if is_nullish(&analysis) {
            undef()
        } else {
            prop(&analysis, "error")?
        };
        let err_s = if truthy(&err_v) {
            js_str(&err_v)
        } else {
            "isteğe yanıt vermedi".to_string()
        };
        subject = format!("{}: web siteniz şu an açılmıyor", js_str(&name_v));
        body = format!(
            "{intro}\n\nSitenize şu an ulaşılamıyor ({err_s}); artık müşteri kaybetmenin en pahalı \
             hâli bu: arayan kişi sayfayı göremeden çıkıyor ve Google da aynı sonucu \
             görüyor.\n\nTeknik SEO, hız ve yapay zekâ görünürlüğü ilk günden içinde olan bir \
             siteyi saniyeler içinde açılır hâle getiriyoruz. Ücretsiz ve bağlayıcı olmayan kısa \
             bir değerlendirmeyi {CHECKUP} adresinden kendiniz de çalıştırabilirsiniz.\n\nUygun \
             olursanız 30 dakikada sorunları birlikte görürüz: {call}{footer}"
        );
    } else {
        let issues = top_issues(analysis.clone(), json!(route_s))?;
        let issues_arr = issues.as_array().cloned().unwrap_or_default();
        let bullets: Vec<String> = issues_arr
            .iter()
            .map(|i| {
                let p = prop(i, "point").unwrap_or(undef());
                let f = prop(i, "fix").unwrap_or(undef());
                format!("• {}\n  Öneri: {}", js_str(&p), js_str(&f))
            })
            .collect();
        let ai = route_s == "ai-visibility";
        subject = if ai {
            format!(
                "{}: siteniz iyi durumda; yapay zekâ aramalarında eksik kaldığı yerler",
                js_str(&name_v)
            )
        } else {
            format!(
                "{}: sitenizin teknik özeti (ücretsiz kontrol)",
                js_str(&name_v)
            )
        };
        let score_line = if ai {
            String::new()
        } else {
            let score_v = if is_nullish(&analysis) {
                undef()
            } else {
                prop(&analysis, "score")?
            };
            let grade_v = if is_nullish(&analysis) {
                undef()
            } else {
                prop(&analysis, "grade")?
            };
            let s = if is_nullish(&score_v) {
                "?".to_string()
            } else {
                js_str(&score_v)
            };
            let g = if is_nullish(&grade_v) {
                "?".to_string()
            } else {
                js_str(&grade_v)
            };
            format!("Ücretsiz kontrolde sitem {s}/100 ({g}).")
        };
        let angle = if ai {
            "\nMüşteriler artık yalnızca Google'da aramıyor; ChatGPT, Gemini ve Perplexity de \
             öneriliyor. Siteniz bu motorların okuyamadığı durumda sizi önermiyor; biz bu katmanı \
             site kurarken ilk günden dahil ediyoruz (llms.txt, şema, temiz HTML)."
                .to_string()
        } else {
            format!(
                "\nBunlar her biri siteden gelen talebi azaltıyor: bulunmuyorsanız gelmiyorsunuz, \
                 gelip anlayamıyorsanız aramadan çıkıyorsunuz. Bu kontrolü {CHECKUP} adresinden \
                 dilediğiniz zaman kendiniz de çalıştırabilirsiniz."
            )
        };
        body = format!(
            "{intro}\n{score_line}\n\nBulduğum başlıca noktalar:\n{}\n{}\n\nBunları nasıl \
             kapatacağınızı 30 dakikalık ücretsiz görüşmede anlatırım; siz yine de kendiniz \
             çözebilirsiniz. Yazmanız yeterli: {call}{footer}",
            bullets.join("\n"),
            angle
        );
    }
    let to_v = if truthy(&email0) {
        email0.clone()
    } else {
        json!("")
    };
    Ok(json!({"route": route_s, "to": to_v, "contact": contact, "subject": subject, "body": body}))
}

// ─── MIME ────────────────────────────────────────────────────────────────────

pub fn b64(s: Value) -> Result<Value, String> {
    let bytes = buffer_bytes(&s)?;
    Ok(json!(b64_encode(&bytes)))
}

pub fn rfc2047(s: Value) -> Result<Value, String> {
    let bytes = buffer_bytes(&s)?;
    Ok(json!(format!("=?UTF-8?B?{}?=", b64_encode(&bytes))))
}

fn destructure_mime(v: &Value) -> Result<(Value, Value, Value, Value, Value), String> {
    match v {
        Value::Null => {
            Err("Cannot destructure property 'from' of 'object null' as it is null.".to_string())
        }
        v if is_undef(v) => {
            Err("Cannot destructure property 'from' of 'undefined' as it is undefined.".to_string())
        }
        Value::Object(o) => Ok((
            o.get("from").cloned().unwrap_or(undef()),
            o.get("to").cloned().unwrap_or(undef()),
            o.get("subject").cloned().unwrap_or(undef()),
            o.get("body").cloned().unwrap_or(undef()),
            o.get("messageId").cloned().unwrap_or(undef()),
        )),
        _ => Ok((undef(), undef(), undef(), undef(), undef())),
    }
}

fn from_escape(line: String) -> String {
    match line.strip_prefix("From ") {
        Some(rest) => format!(">From {rest}"),
        None => line,
    }
}

fn truncate_900(line: String) -> String {
    if line.encode_utf16().count() > 900 {
        String::from_utf16_lossy(&line.encode_utf16().take(900).collect::<Vec<_>>())
    } else {
        line
    }
}

fn mime_lines(body: &Value) -> Result<Vec<String>, String> {
    let units: Vec<u16> = match body {
        Value::Null => return Err("Cannot read properties of null (reading 'split')".to_string()),
        v if is_undef(v) => {
            return Err("Cannot read properties of undefined (reading 'split')".to_string());
        }
        Value::String(_) => js::string_units(body).unwrap_or_default(),
        Value::Object(_) => match js::string_units(body) {
            Some(u) => u,
            None => return Err("body.split is not a function".to_string()),
        },
        _ => return Err("body.split is not a function".to_string()),
    };
    let mut lines: Vec<String> = Vec::new();
    let mut cur: Vec<u16> = Vec::new();
    for u in units {
        if u == u16::from(b'\n') {
            let line = String::from_utf16_lossy(&cur);
            lines.push(truncate_900(from_escape(line)));
            cur.clear();
        } else {
            cur.push(u);
        }
    }
    let line = String::from_utf16_lossy(&cur);
    lines.push(truncate_900(from_escape(line)));
    Ok(lines)
}

pub fn build_mime(arg0: Value) -> Result<Value, String> {
    let (from, to, subject, body, message_id) = destructure_mime(&arg0)?;
    if !truthy(&from) {
        return Err("Gönderen adresi yok (LEAD_AGENT_FROM / site.email).".to_string());
    }
    if !truthy(&to) {
        return Err("Alıcı adresi yok.".to_string());
    }
    let lines = mime_lines(&body)?;
    let date = utc_string(pinned::now_ms()).replacen("GMT", "+0000", 1);
    if is_nullish(&subject) {
        let kind = if subject.is_null() {
            "null"
        } else {
            "undefined"
        };
        return Err(format!(
            "Cannot read properties of {kind} (reading 'includes')"
        ));
    }
    let needs_rfc = match &subject {
        Value::String(s) => {
            s.contains("Non-ASCII") || s.encode_utf16().any(|u| !(0x20..=0x7E).contains(&u))
        }
        Value::Array(_) => js_str(&subject)
            .encode_utf16()
            .any(|u| !(0x20..=0x7E).contains(&u)),
        Value::Object(_) => match js::string_units(&subject) {
            Some(units) => {
                let s = String::from_utf16_lossy(&units);
                s.contains("Non-ASCII") || units.iter().any(|u| !(0x20..=0x7E).contains(u))
            }
            None => return Err("subject.includes is not a function".to_string()),
        },
        _ => return Err("subject.includes is not a function".to_string()),
    };
    let subject_line = if needs_rfc {
        format!(
            "Subject: =?UTF-8?B?{}?=",
            b64_encode(&string_bytes_lossy(&subject))
        )
    } else {
        format!("Subject: {}", js_str(&subject))
    };
    let mid = if truthy(&message_id) {
        js_str(&message_id)
    } else {
        let now_s = js::number_to_string(pinned::now_ms());
        let r36 = number_radix_string36(pinned::random());
        let frac = r36
            .strip_prefix("0.")
            .unwrap_or(if r36 == "0" { "" } else { r36.as_str() });
        format!("{now_s}.{frac}@lead-agent")
    };
    let joined = lines.join("\r\n");
    let encoded = b64_encode(joined.as_bytes());
    let chunks: Vec<String> = encoded
        .as_bytes()
        .chunks(76)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect();
    let mut parts: Vec<String> = vec![
        format!("From: {}", js_str(&from)),
        format!("To: {}", js_str(&to)),
        subject_line,
        format!("Date: {date}"),
        format!("Message-ID: <{mid}>"),
        "MIME-Version: 1.0".to_string(),
        "Content-Type: text/plain; charset=UTF-8".to_string(),
        "Content-Transfer-Encoding: base64".to_string(),
        String::new(),
    ];
    parts.extend(chunks);
    parts.push(String::new());
    Ok(json!(parts.join("\r\n")))
}
