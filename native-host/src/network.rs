use serde_json::Value;
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProxyMode {
    System,
    Direct,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NetworkConfig {
    pub(crate) mode: ProxyMode,
    pub(crate) proxy_url: Option<String>,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            mode: ProxyMode::System,
            proxy_url: None,
        }
    }
}

impl NetworkConfig {
    pub(crate) fn from_payload(payload: &Value) -> Result<Self, &'static str> {
        let mode = match payload["mode"].as_str() {
            Some("system") => ProxyMode::System,
            Some("direct") => ProxyMode::Direct,
            Some("custom") => ProxyMode::Custom,
            _ => return Err("proxy_mode_invalid"),
        };
        let proxy_url = match mode {
            ProxyMode::Custom => Some(validate_proxy_url(
                payload["proxyUrl"].as_str().ok_or("proxy_url_invalid")?,
            )?),
            _ => None,
        };
        Ok(Self { mode, proxy_url })
    }
}

pub(crate) fn add_proxy_args(args: &mut Vec<String>, config: &NetworkConfig, url: &str) {
    match config.mode {
        ProxyMode::Direct => args.extend(["--noproxy".into(), "*".into()]),
        ProxyMode::Custom => {
            if let Some(proxy) = &config.proxy_url {
                args.extend([
                    "--noproxy".into(),
                    String::new(),
                    "--proxy".into(),
                    proxy.clone(),
                ]);
            }
        }
        ProxyMode::System => match system_proxy_for(url) {
            Some(route) => args.extend([
                "--noproxy".into(),
                route.no_proxy,
                "--proxy".into(),
                route.proxy,
            ]),
            None => args.extend(["--noproxy".into(), "*".into()]),
        },
    }
}

fn validate_proxy_url(value: &str) -> Result<String, &'static str> {
    let value = value.trim();
    let parsed = Url::parse(value).map_err(|_| "proxy_url_invalid")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        return Err("proxy_url_invalid");
    }
    Ok(value.trim_end_matches('/').to_string())
}

struct ProxyRoute {
    proxy: String,
    no_proxy: String,
}

#[cfg(windows)]
fn system_proxy_for(url: &str) -> Option<ProxyRoute> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let settings = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    let enabled: u32 = settings.get_value("ProxyEnable").unwrap_or(0);
    if enabled == 0 {
        return None;
    }
    let server: String = settings.get_value("ProxyServer").ok()?;
    let parsed = Url::parse(url).ok()?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    let proxy = select_proxy(&server, &scheme)?;
    let overrides: String = settings.get_value("ProxyOverride").unwrap_or_default();
    if bypasses_local_hostname(parsed.host_str().unwrap_or_default(), &overrides) {
        return None;
    }
    Some(ProxyRoute {
        proxy,
        no_proxy: normalize_proxy_overrides(&overrides),
    })
}

#[cfg(not(windows))]
fn system_proxy_for(_url: &str) -> Option<ProxyRoute> {
    None
}

fn select_proxy(value: &str, scheme: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let selected = if value.contains('=') {
        let entries: Vec<(&str, &str)> = value
            .split(';')
            .filter_map(|entry| entry.trim().split_once('='))
            .map(|(key, endpoint)| (key.trim(), endpoint.trim()))
            .filter(|(_, endpoint)| !endpoint.is_empty())
            .collect();
        entries
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(scheme))
            .or_else(|| {
                entries
                    .iter()
                    .find(|(key, _)| key.eq_ignore_ascii_case("http"))
            })
            .map(|(_, endpoint)| *endpoint)?
    } else {
        value
    };
    let normalized = if selected.contains("://") {
        selected.to_string()
    } else {
        format!("http://{selected}")
    };
    validate_proxy_url(&normalized).ok()
}

fn normalize_proxy_overrides(value: &str) -> String {
    value
        .split(';')
        .filter_map(|entry| normalize_proxy_override(entry.trim()))
        .collect::<Vec<_>>()
        .join(",")
}

fn bypasses_local_hostname(host: &str, overrides: &str) -> bool {
    !host.contains('.')
        && host.parse::<std::net::IpAddr>().is_err()
        && overrides
            .split(';')
            .any(|entry| entry.trim().eq_ignore_ascii_case("<local>"))
}

fn normalize_proxy_override(value: &str) -> Option<String> {
    if value.is_empty() || value.eq_ignore_ascii_case("<local>") {
        return None;
    }
    if let Some(suffix) = value.strip_prefix("*.") {
        return Some(format!(".{suffix}"));
    }
    if let Some(prefix) = value.strip_suffix(".*") {
        let octets: Vec<&str> = prefix.split('.').collect();
        if (1..=3).contains(&octets.len()) && octets.iter().all(|octet| octet.parse::<u8>().is_ok())
        {
            let mut address = octets.join(".");
            for _ in octets.len()..4 {
                address.push_str(".0");
            }
            return Some(format!("{address}/{}", octets.len() * 8));
        }
    }
    Some(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_explicit_modes_and_custom_proxy() {
        assert_eq!(
            NetworkConfig::from_payload(&json!({"mode":"system"})).unwrap(),
            NetworkConfig::default()
        );
        assert_eq!(
            NetworkConfig::from_payload(
                &json!({"mode":"custom","proxyUrl":"http://127.0.0.1:7897/"})
            )
            .unwrap()
            .proxy_url
            .as_deref(),
            Some("http://127.0.0.1:7897")
        );
        for invalid in [
            json!({"mode":"legacy"}),
            json!({"mode":"custom","proxyUrl":"socks5://127.0.0.1:7897"}),
            json!({"mode":"custom","proxyUrl":"http://user:secret@127.0.0.1:7897"}),
            json!({"mode":"custom","proxyUrl":"http://127.0.0.1:7897/path"}),
        ] {
            assert_eq!(
                NetworkConfig::from_payload(&invalid),
                Err(if invalid["mode"] == "legacy" {
                    "proxy_mode_invalid"
                } else {
                    "proxy_url_invalid"
                })
            );
        }
    }

    #[test]
    fn parses_windows_proxy_server_formats() {
        assert_eq!(
            select_proxy("127.0.0.1:7897", "https").as_deref(),
            Some("http://127.0.0.1:7897")
        );
        assert_eq!(
            select_proxy("http=127.0.0.1:8080;https=127.0.0.1:8443", "https").as_deref(),
            Some("http://127.0.0.1:8443")
        );
        assert_eq!(
            select_proxy("http=127.0.0.1:8080", "https").as_deref(),
            Some("http://127.0.0.1:8080")
        );
    }

    #[test]
    fn converts_windows_bypass_patterns_for_curl() {
        assert_eq!(
            normalize_proxy_overrides("localhost;127.*;192.168.*;*.example.test;<local>"),
            "localhost,127.0.0.0/8,192.168.0.0/16,.example.test"
        );
        assert!(bypasses_local_hostname("intranet", "localhost;<local>"));
        assert!(!bypasses_local_hostname("intranet.example", "<local>"));
        assert!(!bypasses_local_hostname("::1", "<local>"));
    }

    #[test]
    fn direct_and_custom_modes_produce_explicit_curl_arguments() {
        let mut direct = Vec::new();
        add_proxy_args(
            &mut direct,
            &NetworkConfig {
                mode: ProxyMode::Direct,
                proxy_url: None,
            },
            "https://example.test/file",
        );
        assert_eq!(direct, ["--noproxy", "*"]);
        let mut custom = Vec::new();
        add_proxy_args(
            &mut custom,
            &NetworkConfig {
                mode: ProxyMode::Custom,
                proxy_url: Some("http://127.0.0.1:7897".into()),
            },
            "https://example.test/file",
        );
        assert_eq!(
            custom,
            ["--noproxy", "", "--proxy", "http://127.0.0.1:7897"]
        );
    }
}
