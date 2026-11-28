# AKM Web access

Assistant includes AKM Web. Selecting Admin's **Knowledge** page opens it automatically inside
Admin without an external browser. By default, this starts a private session
server and stops it when the instance disconnects. Local and SSH access require
a reachable Linux Docker bridge; Docker Desktop is not supported for this mode.

## Keep a URL available

Persistent hosting is optional and off by default. From the instance directory:

```sh
fhold config web --enable --origin http://localhost:3811 --publish
```

This saves the settings and restarts Assistant. The native listener binds to
container port 4097; the published host port defaults to 3811 on `127.0.0.1`.
Use `--port` and `--bind` to select a different host port/address, and make
`--origin` match the URL people will actually visit. It must be an HTTP(S)
origin without a path, query or fragment. Use `--no-apply` to save for later.

For an existing proxy on the container network:

```sh
fhold config web --enable --origin https://knowledge.example.com --no-publish
```

Configure that proxy separately to forward to Assistant port 4097. fhold does
not install a proxy, TLS service or firewall. Use those protections when
exposing the UI beyond the host. Host and Origin validation do not identify
client machines or encrypt HTTP traffic.

`fhold config web` prints non-secret settings. `fhold config web --disable`
removes the listener and its managed port/mount on the next apply, while
retaining the login file for re-enabling.

## Login and Admin

On first enablement, fhold creates a random login secret in
`state/secrets/fhold_akm_web_secret`, readable only by the host owner. Retrieve
it privately on that host and enter it into AKM's login form; do not put it in
a URL, chat, stack settings or logs. AKM owns the login cookie, logout and
session expiration. To rotate it, replace the file with a cryptographically
random secret of at least 32 printable non-space characters, preserve mode
0600, and restart Assistant. Existing browser sessions end on restart.

Admin reads this dedicated file and authenticates its isolated browser view
for the configured origin. It does not send the secret to the Admin renderer.
With persistent hosting, closing Admin leaves the web server running. For SSH
instances, the configured URL must be reachable from the Admin workstation;
Admin does not rewrite its canonical origin or create a persistent-mode tunnel.

Only the web login file is mounted, not the host's secret directory or the
credential delegate's store. The Assistant account can read its own web login
secret; this login is not a credential-custody boundary against the assistant.

## Embed in another app

AKM owns these settings in `config/akm/config.json`. Merge the following into
the existing configuration, preserving the other settings:

```json
{
  "experimental": {
    "web": {
      "frameParents": ["https://app.example.com", "https://dashboard.example.com"]
    }
  }
}
```

Restart Assistant after editing native settings. Framing is denied by default.
Every ancestor of a nested frame must be allowed. `frameParents` permits display;
it does not grant the parent app cross-origin API access. `allowedHosts` is
AKM's HTTP Host allowlist, not a list of client computers permitted to connect.
fhold supplies the listener host, port, origin and dedicated secret; AKM still
owns framing and host validation.

Cross-site cookie login depends on browser policy. AKM uses secure partitioned
cookies for configured HTTPS framing, but a parent allowlist cannot override
blocked third-party cookies or mixed-content restrictions. Test your actual
browser and deployment. Arbitrary cross-site HTTP embedding is not promised.

## Readiness and activity

The existing health and keep-alive checks consume AKM's authenticated native
`/api/session` readiness/activity result. An idle listener does not keep the
assistant awake; active work or an unknown response prevents an idle decision.
An optional web failure reports degraded health without stopping OpenCode.
AKM drains and stops its writers during shutdown before fhold's final checkpoint.

See the [implementation contract](technical/akm-web-hosting-proposal.md) and
[verification record](technical/akm-web-premerge-review.md) for qualified scope.
