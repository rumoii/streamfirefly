pub(crate) fn header_name_ok(name: &str) -> bool {
    ["referer", "origin", "authorization", "cookie", "user-agent"]
        .iter()
        .any(|allowed| name.eq_ignore_ascii_case(allowed))
}

pub(crate) fn header_value_ok(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte == b'\t' || (byte >= 0x20 && byte != 0x7f))
}
