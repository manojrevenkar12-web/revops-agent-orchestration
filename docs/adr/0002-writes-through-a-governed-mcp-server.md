# 0002 Every GTM read and write goes through one MCP server, writes need an approval token

Status: accepted

Alternatives: connectors in each worker (credentials everywhere, no single audit), or an agent with direct write
tools (no way to bind a write to a decision). The MCP server holds the credentials, enforces scopes (an analyst token
sees only read tools and masked e-mail addresses), validates arguments strictly, and requires for every write an
HMAC token that names the tool, the hash of the exact arguments, who approved and an expiry. Tokens are issued only
by `approval.issue`, which the agent cannot call. The same server serves Claude Desktop and Claude Code for analysts,
read-only.
