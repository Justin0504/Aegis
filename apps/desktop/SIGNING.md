# Signing + notarization playbook

Everything required to ship a signed, notarized, auto-updating release
of the AEGIS desktop app. Run once per platform; the rest is CI.

Status right now:

| Piece | State |
|---|---|
| Tauri build config | shipped |
| GitHub Actions release workflow | shipped (`.github/workflows/desktop-release.yml`) |
| Auto-updater endpoint | shipped (points at `latest.json` in GitHub releases) |
| **Tauri updater signing key** | **MISSING — generate + set GitHub secret** |
| **Apple Developer certificate** | **MISSING — needs $99/yr Apple Developer account** |
| **Windows EV code-signing cert** | **MISSING — needs $200–400/yr cert from Sectigo / DigiCert** |

Anything with **MISSING** is what's between you and Gatekeeper-clean +
SmartScreen-clean releases.

## 1. Tauri updater signing key (~5 min, free)

Signs the auto-update payload so a compromised GitHub can't push a
malicious binary to installed apps.

```bash
# Install the Tauri CLI if you haven't:
npm install -g @tauri-apps/cli

# Generate the keypair. You'll be prompted for a passphrase.
tauri signer generate -w ~/.aegis/tauri-updater.key

# → creates ~/.aegis/tauri-updater.key (private, KEEP SECRET)
# → prints the public key to stdout — copy it.
```

Then:

1. Paste the printed **public key** into `apps/desktop/src-tauri/tauri.conf.json`
   at `plugins.updater.pubkey`, replacing `AEGIS_UPDATER_PUBKEY_PLACEHOLDER`.
2. Add two GitHub Actions secrets in the repo:
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of `~/.aegis/tauri-updater.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the passphrase you chose

The workflow already wires these into the `tauri-apps/tauri-action@v0` step.

Test by tagging a release (`git tag v0.2.1 && git push --tags`) and
verifying `latest.json` on the release contains a `signature` field.

## 2. macOS signing + notarization ($99/yr, ~24h approval)

Without this, macOS Gatekeeper blocks the .dmg with a "damaged" or
"unidentified developer" error. Users must right-click → Open → Open,
which is a real conversion killer.

### One-time setup

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/enroll/) — $99/yr, ~24h approval.
2. Sign in to Xcode, `Settings → Accounts`, add your Apple ID.
3. `Manage Certificates → +` → **Developer ID Application**.
   Xcode generates the cert + key in your login keychain.
4. Export the cert **including the private key** as a `.p12`:
   ```
   Keychain Access → find "Developer ID Application: <your name>" →
     right-click → Export → format = .p12, set an export password
   ```
5. Base64-encode the .p12 for GitHub:
   ```bash
   base64 -i ~/Downloads/aegis-signing.p12 | pbcopy
   ```
6. Create an app-specific password for notarization:
   [appleid.apple.com](https://appleid.apple.com) → Sign-in and security →
   App-Specific Passwords → generate one labelled "AEGIS notarization".

### GitHub secrets

Add all five:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64-encoded .p12 contents |
| `APPLE_CERTIFICATE_PASSWORD` | the .p12 export password from step 4 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: <Your Name> (TEAMID)` — copy exactly from Keychain Access |
| `APPLE_ID` | your Apple Developer email |
| `APPLE_PASSWORD` | the app-specific password from step 6 |
| `APPLE_TEAM_ID` | 10-char team ID from [developer.apple.com/account](https://developer.apple.com/account) |

The `tauri-action@v0` step in `desktop-release.yml` already reads
all six. Nothing to change in the workflow.

### Verify a signed build

After the release CI runs, download the .dmg on a fresh Mac (or one
where you've never opened AEGIS):

```bash
spctl --assess --verbose /Volumes/AEGIS/AEGIS.app
# → should print: "accepted   source=Notarized Developer ID"
```

If it does, you're clean. Double-click opens without any warning.

## 3. Windows code signing ($200–400/yr, ~1–3 day KYC)

Without this, Windows SmartScreen shows a red-bordered "Windows
protected your PC" screen; only about 20% of users click through.

**EV (Extended Validation)** certs are worth the extra cost over OV
because EV clears SmartScreen reputation immediately; OV takes weeks
of downloads to build reputation.

### Options

- **Sectigo EV** — ~$350/yr, [sectigo.com/ssl-certificates-tls/code-signing/ev-code-signing](https://www.sectigo.com/ssl-certificates-tls/code-signing/ev-code-signing)
- **DigiCert EV** — ~$400/yr, [digicert.com/signing/code-signing-certificates](https://www.digicert.com/signing/code-signing-certificates)
- **SSL.com EV** — ~$260/yr, cheaper and known-good with GitHub Actions

All three ship the cert on a USB hardware token (EV requirement). For
CI, you need to use a cloud HSM alternative — SSL.com and DigiCert
both support this via their cloud signing service.

### Once you have the cert

1. Get the SHA1 thumbprint (Windows: certmgr.msc → find cert → details).
2. Set in `apps/desktop/src-tauri/tauri.conf.json`:
   ```json
   "windows": {
     "certificateThumbprint": "ABCD1234...",
     "digestAlgorithm": "sha256",
     "timestampUrl": "http://timestamp.digicert.com"
   }
   ```
3. Update the release workflow to authenticate against your cloud
   signing service (steps depend on vendor — SSL.com has a Windows
   action, DigiCert has `DigiCertOne-Signing-Manager-Tools`).

### Verify

```powershell
Get-AuthenticodeSignature "AEGIS_0.2.0_x64_en-US.msi"
# → Status : Valid
# → SignerCertificate.Subject : matches your org name
```

## 4. Release cadence

Once all three are set up, a full release is one command:

```bash
git tag v0.3.0
git push origin v0.3.0
```

CI runs 30–60 min later. Assets land on the GitHub release, and every
existing install auto-updates within the next 6-hour update-check
window (Tauri default; configurable per-app).

## Fallback for right now (no certs yet)

The current unsigned builds still work — they just show Gatekeeper /
SmartScreen warnings on first launch. The download page already
documents the right-click-→-Open workaround (macOS) and the More info
→ Run anyway workaround (Windows). This is fine for a public beta,
but conversion drops ~30–40% at each warning screen — not something
you want to leave in place past first paid customer.
