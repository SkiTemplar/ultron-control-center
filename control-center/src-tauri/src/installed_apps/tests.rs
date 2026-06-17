// installed_apps/tests.rs — unit tests for the installed-apps domain.

#[cfg(all(test, target_os = "windows"))]
use super::bloatware::is_valid_appx_pattern;
#[cfg(all(test, target_os = "windows"))]
use super::ps_util::ps_single_quote_escape;

/// Replays the provider whitelist gate from `uninstall_app_inner` —
/// the actual function needs an `&tauri::AppHandle` we can't build in
/// a unit test, so we exercise the discriminator directly.
#[cfg(all(test, target_os = "windows"))]
fn provider_whitelist_check(provider: &str) -> Result<String, String> {
    match provider {
        "winget" | "store" | "msi" | "manual" => Ok(provider.to_string()),
        other => Err(format!("invalid provider '{}'", other)),
    }
}

#[cfg(all(test, target_os = "windows"))]
#[test]
fn provider_whitelist_rejects_unknown() {
    for p in ["winget", "store", "msi", "manual"] {
        assert!(
            provider_whitelist_check(p).is_ok(),
            "expected '{}' to pass whitelist",
            p
        );
    }
    for bad in ["", "WINGET", "rpm", "deb", "; rm -rf /", "msi'; bad"] {
        let err = provider_whitelist_check(bad).unwrap_err();
        assert!(
            err.contains("invalid provider"),
            "expected rejection for '{}', got '{}'",
            bad,
            err
        );
    }
}

#[cfg(all(test, target_os = "windows"))]
#[test]
fn ps_single_quote_escape_doubles_quotes() {
    // No quotes — passthrough
    assert_eq!(ps_single_quote_escape("hello"), "hello");
    // One quote — doubled
    assert_eq!(ps_single_quote_escape("d'arc"), "d''arc");
    // Multiple quotes — each doubled
    assert_eq!(ps_single_quote_escape("'a'b'"), "''a''b''");
    // Backslash, $, backtick are literal inside PS single quotes; left as-is.
    assert_eq!(
        ps_single_quote_escape("C:\\Program Files"),
        "C:\\Program Files"
    );
    assert_eq!(ps_single_quote_escape("$var"), "$var");
    assert_eq!(ps_single_quote_escape("`backtick`"), "`backtick`");
}

#[cfg(all(test, target_os = "windows"))]
#[test]
fn appx_pattern_accepts_valid_family_names() {
    for ok in [
        "Microsoft.XboxApp",
        "Microsoft.XboxGamingOverlay*",
        "king.com.CandyCrushSaga",
        "Microsoft.Windows.Photos",
        "*Xbox*",
        "A.B-C_D",
    ] {
        assert!(is_valid_appx_pattern(ok), "expected '{}' to be valid", ok);
    }
}

#[cfg(all(test, target_os = "windows"))]
#[test]
fn appx_pattern_rejects_injection_attempts() {
    for bad in [
        "",
        "Microsoft.XboxApp; Remove-Item C:\\",
        "Microsoft.XboxApp'; bad",
        "Microsoft.XboxApp $(rm)",
        "Microsoft.XboxApp`whoami",
        "with spaces",
        "with/slash",
        "with\\backslash",
    ] {
        assert!(
            !is_valid_appx_pattern(bad),
            "expected '{}' to be rejected",
            bad
        );
    }
}
