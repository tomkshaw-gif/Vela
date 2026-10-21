# LuxAlgo upstream inventory

Checked 20 October 2026 using the public organization inventory, default-branch
trees, package metadata and relevant source. Fifteen public repositories were
visible. This is a point-in-time inventory; it does not describe private services.

| Repository | License | Relevance to this app |
| --- | --- | --- |
| [Vela](https://github.com/LuxAlgo/Vela) | Apache-2.0 | Chart, workspace and public plugin extension API; current base 0.8.5 |
| [Vela-pinets](https://github.com/LuxAlgo/Vela-pinets) | AGPL-3.0 | Official Pine worker adapter; installed 0.2.17 |
| [PineTS](https://github.com/LuxAlgo/PineTS) | AGPL-3.0 | Indicator and strategy runtime; installed 0.12.0 |
| [luxalgo-mcp-server](https://github.com/LuxAlgo/luxalgo-mcp-server) | MIT, with separate content notices | Optional library and research tools; it does not control the local chart |
| [prop-firm-sim](https://github.com/LuxAlgo/prop-firm-sim) | MIT | Candidate for rule-based challenge Monte Carlo and risk sweeps |
| [edge-stats](https://github.com/LuxAlgo/edge-stats) | MIT; dataset notices also apply | Candidate for conditional historical session statistics |
| [pinets-cli](https://github.com/LuxAlgo/pinets-cli) | AGPL-3.0 | Offline plot tooling; its older runtime adds little to the installed worker |
| [broker-sdk](https://github.com/LuxAlgo/broker-sdk) | MIT | Broker adapter patterns; no live connection is added here |
| [trade-journal](https://github.com/LuxAlgo/trade-journal) | MIT | Journal and annotation patterns; local session ledgers already exist |
| [trade-relay](https://github.com/LuxAlgo/trade-relay) | MIT | Trade-routing infrastructure outside local practice scope |
| [whale-options](https://github.com/LuxAlgo/whale-options) | MIT | Options research rather than futures replay |
| [market-trackers](https://github.com/LuxAlgo/market-trackers) | MIT | External public-record research pipeline |
| [market-trackers-data](https://github.com/LuxAlgo/market-trackers-data) | CC0-1.0 | Optional external research datasets |
| [cla-signatures](https://github.com/LuxAlgo/cla-signatures) | No software license declared | Contributor administration |
| [.github](https://github.com/LuxAlgo/.github) | No software license declared | Organization metadata |

Vela default-branch revision is
`596cbbdeba15406cfb72465afd07f8c60c6b1852`; the addon revision is
`2e434bf092310a4029fc2e17e1fa4691388cfe11`; PineTS is
`3dde7eb1d3bce92025e741cede148f437bb58d03`. The installed versions matched the
latest published versions at this check. No dependency upgrade resulted.

## Agent integration

The public [plugin SDK](https://github.com/LuxAlgo/Vela/blob/main/docs/contributing/plugin-sdk.md)
extends a chart host. No separate public Vela agent SDK was found in the public
repositories, package names, documentation or compared Vela branches. The
official MCP server provides research, library and account-related tools; its
README explicitly describes charts as a browser application rather than a chart
control tool. Hosted Quant functionality does not establish a public local SDK.

This app therefore exposes Vela's public chart and scripting seams through its
own local MCP connection. See [MCP.md](MCP.md). No hosted model is required by
the app, and no external MCP service was installed by this inventory.

## Candidates for later work

The strongest addition is the prop challenge simulator: feed local R-multiples
and explicit rules into seeded challenge attempts. Its futures rule mappings
would need runtime verification, especially trailing drawdown. A public firm
directory should not silently fill gaps in the user's configured rule model.

Library source discovery could make it easier to try public indicators using the
existing worker. Script licenses remain separate from the MCP server's license,
and individual scripts need compatibility checks before being bundled.

Edge Stats can add conditional probabilities, sample sizes and confidence
intervals. It requires a suitable history span, an explicit cache adapter and
Windows verification. Two days of cached candles cannot establish a substantial
session sample. No market statistics are invented from that limited sample.

These candidates were researched, not installed or runtime-verified. The current
manual prop simulator, seeded trade simulations, Pine worker and local bridge
remain the implemented features.
