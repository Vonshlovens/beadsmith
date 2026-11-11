# Model pool

Agents that Beadsmith launches can reach their models through
[Underclass](https://github.com/ghuntley/underclass), which pools several
model subscriptions behind one endpoint and moves work between them as their
quotas fill ([ADR-0022](../specs/decisions/0022-underclass-model-gateway.md)).
The console's **Model pool** page (`/console/model-pool`, linked from the
Dispatch row of the console's Health panel) shows that pool to admins, so you
can tell whether it can take more work, and which account is holding it back,
without opening Underclass's own interface.

The page is read-only. Signing an account back in, turning one on or off, or
spending a banked reset still happens in Underclass.

## Turning it on

Set both settings and restart Beadsmith (see
[configuration](configuration.md)):

| Setting                        | Value                                                                      |
| ------------------------------ | -------------------------------------------------------------------------- |
| `BDX_UNDERCLASS_URL`           | The origin of Underclass's admin API: `https://host[:port]`, with no path. |
| `BDX_UNDERCLASS_UI_TOKEN_FILE` | A file holding Underclass's UI token.                                      |

Without either setting the page says the pool is not connected. With only
one, or with a URL that is not a bare HTTPS origin, it names the setting to
fix. Settings are read when the server starts, so the page stops refreshing
until you restart.

The token can do much more in Underclass than this page needs, so Beadsmith
keeps it on the server: it sends it only to `BDX_UNDERCLASS_URL`, only for
four fixed read routes, and never shows, logs or stores it. Nothing the
browser sends reaches Underclass. The [contract](contract.md) lists exactly
what the console API returns.

## Reading the page

The line under the heading says when Underclass was last read. While the tab
is visible the page reads again every 15 seconds, and **Refresh** reads at
once.

- **The summary** counts accounts in rotation (healthy ones taking requests),
  requests in flight, attempts in the last minute, requests and peak
  concurrency over the last 24 hours, and month-to-date attempts and tokens.
- **Accounts** has one row per subscription: its address and backend, its
  state, its quota windows, and its counters.
  - _healthy_ accounts take requests.
  - _cooling_ accounts hit a limit and are out of rotation until the time
    shown.
  - _sign-in failed_ accounts will not recover by waiting: sign in again in
    Underclass.
  - _disabled_ accounts were turned off in Underclass.

  Each quota window (Claude's 5-hour, 7-day and 7-day Fable windows; Codex's
  windows named by their length) shows the share used and when it resets.
  The bar turns amber from 80 % and red at the limit. A dash means the
  backend did not report that window, which is not the same as 0 %.
  _Sessions_ are conversations pinned to the account so its prompt cache
  stays warm. _Banked_ counts the rate-limit resets the subscription can
  spend.

- **Last 24 hours** charts requests per hour. Hover a bar, or focus the chart
  and use the arrow keys, to read each hour; **Show as a table** lists every
  hour. Beside it are the outcomes of finished requests and the upstream
  events (overloads, rate limits, sign-in failures) Underclass recorded.
- **By model, month to date** splits requests and tokens by model. _Without
  usage_ counts requests that succeeded but reported no token usage.
- **Recent attempts** lists the last 20 upstream attempts, newest first, with
  their result in red when they failed.

If a refresh fails after the page has shown the pool, the last good reading
stays on screen under a banner that says how old it is and what failed. A
first read that fails shows only the failure and a retry button. The four
failures are a token file Beadsmith cannot read, a token Underclass rejects,
an Underclass that does not answer, and an answer Beadsmith cannot parse.

## Operator check

Unit tests run the page's logic against recorded Underclass payloads. After
deploying with the settings above, check the live pool once:

1. Open `/console/model-pool` as an admin. The accounts listed match
   Underclass's own account list, with the same states.
2. Start an agent mission and refresh. _In flight_ rises while it runs, and
   the attempt appears under **Recent attempts**.
3. Replace the token file's contents with a wrong value and refresh: the page
   keeps the last reading and says Underclass rejected the token. Restore the
   file and refresh to clear the banner.
