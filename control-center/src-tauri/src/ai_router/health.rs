// Cliente HTTP compartido del AI Router.

use std::time::Duration;

pub(crate) const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("build http client: {}", e))
}
