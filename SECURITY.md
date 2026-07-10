# Security Policy

## Reporting a Vulnerability

We take the security of OninOneProxy seriously. If you believe you have discovered a security vulnerability, please follow the process below.

### Do **not** open a public GitHub Issue

Security vulnerabilities must **not** be reported via the public GitHub Issue tracker. Publicly disclosing a vulnerability before a fix is available puts users at risk.

### How to report

Please report security issues through **GitHub Security Advisory**:

1. Go to https://github.com/Vincent-A-Yang/OninOneProxy/security/advisories/new
2. Fill in the advisory form with:
   - A description of the vulnerability
   - Steps to reproduce or a proof of concept
   - The affected version(s)
   - Any suggested mitigation

You can also use the **"Report a vulnerability"** button on the repository's **Security** tab.

We aim to acknowledge receipt of security reports within **72 hours** and to provide an initial assessment within **7 days**.

### Coordinated disclosure

We follow a coordinated disclosure model:

1. We confirm the vulnerability and assess its impact.
2. We develop and test a fix.
3. We release a patched version and publish a security advisory with credit to the reporter (unless anonymity is requested).
4. Public disclosure happens **after** a fix is available.

## Supported Versions

Only the latest release line receives security updates. Older versions are supported on a best-effort basis.

| Version | Supported       |
|---------|-----------------|
| 0.5.x   | ✅ Active       |
| < 0.5   | ❌ Not supported |

## Attribution

OninOneProxy is a derivative work based on [9Router](https://github.com/decolua/9router) by **decolua**, used under the MIT License. Security-relevant upstream fixes are tracked and ported when applicable.

## License

This project is licensed under the **MIT License**. See [LICENSE](./LICENSE) for details.
