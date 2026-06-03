//! Text cleanup and redaction helpers.
//!
//! IRC traffic can contain control codes and credentials. These helpers are used
//! before writing debug lines, native notifications, or disk logs so sensitive
//! commands do not leak and display text stays readable.

pub(crate) fn sanitize_log_text(input: &str, max_chars: usize) -> String {
    input
        .chars()
        .map(|c| if c.is_control() && c != '\t' { ' ' } else { c })
        .take(max_chars)
        .collect()
}

pub(crate) fn truncate_text(input: &str, max_chars: usize) -> String {
    let mut out: String = input.chars().take(max_chars).collect();
    if input.chars().count() > max_chars {
        out.push('…');
    }
    out
}

pub(crate) fn redact_sensitive_text(input: &str) -> String {
    let out = input.to_string();
    for marker in [
        "IDENTIFY ",
        "identify ",
        "PASS ",
        "pass ",
        "PRIVMSG NickServ :IDENTIFY ",
    ] {
        if let Some(idx) = out.find(marker) {
            let prefix = &out[..idx + marker.len()];
            return format!("{}[redacted]", prefix);
        }
    }
    out
}

pub(crate) fn redact_command_for_log(command: &str) -> String {
    let upper = command.trim_start().to_uppercase();
    if upper.starts_with("IDENTIFY ")
        || upper.starts_with("PASS ")
        || upper.starts_with("NS IDENTIFY ")
        || upper.starts_with("NICKSERV IDENTIFY ")
        || upper.contains(" NICKSERV :IDENTIFY ")
    {
        "[redacted command]".to_string()
    } else {
        truncate_text(command, 512)
    }
}

pub(crate) fn clean_irc_display_text(input: &str) -> String {
    let mut cleaned = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            // mIRC color codes are a control byte followed by optional numeric
            // foreground/background values. Dropping only the control byte leaves
            // ugly "8,15" prefixes in topics and LIST rows, so consume the whole
            // formatting sequence before returning user-visible text.
            '\x03' => {
                skip_ascii_digits(&mut chars, 2);
                skip_optional_mirc_background(&mut chars);
            }
            // Some networks send hex color codes. They follow the same idea as
            // mIRC colors but use up to six hexadecimal digits per color.
            '\x04' => {
                skip_ascii_hex_digits(&mut chars, 6);
                skip_optional_hex_background(&mut chars);
            }
            '\x02' | '\x0f' | '\x11' | '\x16' | '\x1d' | '\x1e' | '\x1f' => {}
            '\t' => cleaned.push(ch),
            _ if ch.is_control() => {}
            _ => cleaned.push(ch),
        }
    }

    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn skip_ascii_digits<I>(chars: &mut std::iter::Peekable<I>, max: usize)
where
    I: Iterator<Item = char>,
{
    let mut skipped = 0;
    while skipped < max {
        match chars.peek().copied() {
            Some(ch) if ch.is_ascii_digit() => {
                chars.next();
                skipped += 1;
            }
            _ => break,
        }
    }
}

fn skip_ascii_hex_digits<I>(chars: &mut std::iter::Peekable<I>, max: usize)
where
    I: Iterator<Item = char>,
{
    let mut skipped = 0;
    while skipped < max {
        match chars.peek().copied() {
            Some(ch) if ch.is_ascii_hexdigit() => {
                chars.next();
                skipped += 1;
            }
            _ => break,
        }
    }
}

fn skip_optional_mirc_background<I>(chars: &mut std::iter::Peekable<I>)
where
    I: Iterator<Item = char>,
{
    if chars.peek().copied() == Some(',') {
        chars.next();
        skip_ascii_digits(chars, 2);
    }
}

fn skip_optional_hex_background<I>(chars: &mut std::iter::Peekable<I>)
where
    I: Iterator<Item = char>,
{
    if chars.peek().copied() == Some(',') {
        chars.next();
        skip_ascii_hex_digits(chars, 6);
    }
}

pub(crate) fn clean_nickname(input: &str) -> Option<String> {
    let nick = input.trim();
    if nick.is_empty() {
        None
    } else {
        Some(nick.to_string())
    }
}

pub(crate) fn fallback_nicks(primary: &str, configured_alt: Option<&str>) -> Vec<String> {
    let mut nicks = Vec::new();
    for candidate in [
        configured_alt.and_then(clean_nickname),
        clean_nickname(&format!("{}_", primary)),
        clean_nickname(&format!(
            "{}{}",
            primary,
            chrono::Local::now().format("%H%M")
        )),
        clean_nickname(&format!("Rumblr{}", chrono::Local::now().format("%M%S"))),
    ]
    .into_iter()
    .flatten()
    {
        if candidate != primary && !nicks.iter().any(|nick| nick == &candidate) {
            nicks.push(candidate);
        }
    }
    nicks
}

#[cfg(test)]
mod tests {
    use super::clean_irc_display_text;

    #[test]
    fn strips_mirc_color_numbers_from_display_text() {
        assert_eq!(
            clean_irc_display_text("\x038,15For free files\x0f"),
            "For free files"
        );
        assert_eq!(
            clean_irc_display_text("\x0304,01red alert\x03 normal"),
            "red alert normal"
        );
    }

    #[test]
    fn strips_hex_color_numbers_from_display_text() {
        assert_eq!(
            clean_irc_display_text("\x04ff5500,000000orange text"),
            "orange text"
        );
    }

    #[test]
    fn preserves_plain_digits_after_normal_text() {
        assert_eq!(
            clean_irc_display_text("Type 7 to upload"),
            "Type 7 to upload"
        );
    }
}
