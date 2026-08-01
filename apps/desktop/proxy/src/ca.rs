//! CA material for the transparent proxy.
//!
//! Generates the AEGIS root cert + private key on first launch and
//! persists to disk with 0600 perms. Hudsucker handles per-host leaf
//! cert generation internally, so we only mint + hold the root.
//!
//! ## Security posture
//!
//! - Private key stays in the user's data directory (never exported).
//! - PEM perms are 0600 on unix. Windows relies on NTFS user-scoped
//!   AppData ACLs — same posture as SSH keys under `%USERPROFILE%\.ssh`.
//! - The PEM cert (public) is written to a stable well-known path so
//!   the trust-store install commands (system_proxy.rs on the Tauri
//!   side) can point at it without any IPC dance.

use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, KeyPair,
    KeyUsagePurpose,
};
use std::fs;
use std::path::PathBuf;

const CA_COMMON_NAME: &str = "AEGIS Proxy CA";
const CA_ORG: &str = "AEGIS";

pub struct CaPaths {
    pub key_pem: PathBuf,
    pub cert_pem: PathBuf,
}

impl CaPaths {
    pub fn platform_default() -> Self {
        let base = ca_dir();
        Self {
            key_pem: base.join("aegis-proxy-ca.key"),
            cert_pem: base.join("aegis-proxy-ca.crt"),
        }
    }
}

fn ca_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join("Library/Application Support/AEGIS")
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("APPDATA").unwrap_or_default();
        PathBuf::from(base).join("AEGIS")
    }
    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join(".config/aegis")
    }
}

/// Load-or-init the root CA. Returns the PEM-loaded KeyPair + parsed
/// Certificate ready to hand to hudsucker's RcgenAuthority.
pub fn load_or_init(paths: &CaPaths) -> Result<(KeyPair, rcgen::Certificate), Box<dyn std::error::Error>> {
    if let Some(base) = paths.cert_pem.parent() {
        fs::create_dir_all(base)?;
    }

    let (cert_pem, key_pem) = if paths.cert_pem.exists() && paths.key_pem.exists() {
        (
            fs::read_to_string(&paths.cert_pem)?,
            fs::read_to_string(&paths.key_pem)?,
        )
    } else {
        let (c, k) = generate_root()?;
        fs::write(&paths.cert_pem, &c)?;
        fs::write(&paths.key_pem, &k)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&paths.key_pem)?.permissions();
            perms.set_mode(0o600);
            fs::set_permissions(&paths.key_pem, perms)?;
        }
        tracing::info!(target: "aegis-proxy", path = %paths.cert_pem.display(), "generated AEGIS root CA");
        (c, k)
    };

    let key_pair = KeyPair::from_pem(&key_pem)?;
    let params = CertificateParams::from_ca_cert_pem(&cert_pem)?;
    let cert = params.self_signed(&key_pair)?;
    Ok((key_pair, cert))
}

fn generate_root() -> Result<(String, String), Box<dyn std::error::Error>> {
    let key_pair = KeyPair::generate()?;
    let mut params = CertificateParams::new(vec![])?;
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.distinguished_name = {
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, CA_COMMON_NAME);
        dn.push(DnType::OrganizationName, CA_ORG);
        dn
    };
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let cert = params.self_signed(&key_pair)?;
    Ok((cert.pem(), key_pair.serialize_pem()))
}
