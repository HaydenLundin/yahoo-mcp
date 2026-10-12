# Adversarial review before tagging 1.0 (2026-10-11)

Target: yahoo-mcp 1.0.0-rc.1 (commit b696c22): `src/`, `wrangler.jsonc`, `migrations/`, docs.

Process: four roles run as separate agents with competing incentives. A baseline reviewer ran a 17-item release-readiness checklist (23 findings, NEEDS FIXES). A Finder scored them and added four of its own (27 findings, 76 points). An Adversary tried to disprove each one, loses double for a wrong challenge, and yielded on all 27 after reproducing nine in the fake IMAP harness. A Referee re-read the code independently, adjusted two severities, added four items both sides missed, and produced the verdict below. No repository file was modified during the review. Two agents each made one accidental IMAP login attempt against Yahoo with the test harness's placeholder credentials (rejected; no real credential involved).

**Verdict: NEEDS FIXES. Confidence 75%.** Two CRITICAL findings, both with small fixes, block the tag. Nothing requires a redesign.

---

## Final report (Referee)

B1 -- CRITICAL -- UPHELD (+10)
  Moving a message into Drafts, then delete_draft or update_draft, permanently erases any mail.
  - organize.ts takes a free-form to_folder. delete_draft and update_draft only check the uid exists in Drafts, never the \Draft flag; imapflow's messageDelete is STORE \Deleted plus UID EXPUNGE.
  - Repro in the fake harness: INBOX 101 moved to "Draft" as uid 10, then delete_draft 10 returned deleted:true and no copy remained in any folder.
  - Breaks "no permanent delete" in the model instructions (server.ts), the consent text (types.ts), ARCHITECTURE.md and OVERVIEW.md.
  - move_messages and update_draft are annotated non-destructive, so an auto-approving client runs the whole chain without a prompt. Needs mail.organize + mail.draft, both in the default grant, so it is live in production today.

B2 -- CRITICAL -- UPHELD (+10)
  The Bcc header goes out in the SMTP DATA payload.
  - compose.ts writes "Bcc:"; send.ts stages that MIME and passes it verbatim to sendRaw; smtp.ts sends dotStuff(raw) including all headers. Nothing strips it; the existing test locks the behaviour in.
  - Actual leakage depends on whether smtp.mail.yahoo.com strips Bcc, which is unmeasured. RFC 5322 section 3.6.3 puts the duty on the submitter. Outcome class is disclosure to third parties and the fix is small, so it blocks the tag regardless. Production exposure today is zero because SEND_ENABLED is off.

B3 -- LOW -- UPHELD-ADJUSTED (+1, from MEDIUM)
  Consent phishing surface: open DCR and CIMD, attacker-chosen client name as the headline, redirect host in muted text, empty scope means all four scopes (consent.ts resolveScopes). Lowered because the operator must still pass Access and click Allow, no documented guarantee is broken, and names and hosts are escaped. Impact if it works is full mailbox access, so it ranks first among the 1.0.x items.

B4 -- MEDIUM -- UPHELD (+5)
  Unauthenticated DCR can fill KV with 1 MiB records that live 90 days (provider default TTL; name and redirect_uris unbounded; no clientRegistrationCallback; nothing purges client: records). The limiter keys on the full IP, so an IPv6 attacker rotates within a /64. KV Free allows 1,000 writes/day: one IP at 5/min exhausts that in about 3.5 hours and blocks OAuth token writes until 00:00 UTC.

B5 -- MEDIUM -- UPHELD (+5)
  The confirm step is advisory and the docs overclaim. confirm_send takes only the token, which the model holds; no human binding, no send budget. Two-phase itself is sound (single-use atomic consume), so not CRITICAL. OVERVIEW.md ("limits what a hijacked assistant can do"), ARCHITECTURE.md ("user-in-the-loop") and the consent text overstate it. Fix: reword now; optional hardening later (elicitation, recipient allowlist, daily cap).

B6 -- MEDIUM -- UPHELD (+5)
  The preview omits body_html, which most recipients see. The HTML goes into a multipart/alternative message that clients prefer; the preview and PendingPreview carry text only.

B7 -- MEDIUM -- UPHELD (+5)
  A mail.send-only grant can read any message via the reply and forward previews: forward_message returns the original body as preview.body_text with no confirm, and the send tools register on mail.send alone. Breaks the "never register a tool outside its scope group" rule.

B8 -- MEDIUM -- UPHELD (+5)
  Cut bodies are returned with truncated:false. readBody caps raw bytes at limit*4+4096; downloadText stops there and signals nothing; truncateText judges only decoded length. Repro: a 300,072-byte markup-heavy HTML-only part came back as 40,632 chars with truncated:false and the footer missing. Breaks ARCHITECTURE.md "note truncation".

B9 -- LOW -- UPHELD (+1)
  No operator identity check behind Access; algorithms not pinned (access.ts).

B10 -- LOW -- UPHELD (+1)
  confirm_send and move audit rows carry no recipients or destination; audit write failure is swallowed.

B11 -- LOW -- UPHELD (+1)
  get_thread reports a 1-message thread when the References search returns false (read.ts coerces false to []).

B12 -- LOW -- UPHELD-ADJUSTED (+1, from MEDIUM)
  Quota exhaustion on the Free plan (100k requests/day, 100k KV reads/day via invalid bearers); no per-client call budget. Platform property with no in-Worker fix; transient; the persistent, code-fixable part is B4.

B13 -- LOW -- UPHELD (+1)
  No CI; FakeD1 is a string-matching fake; the live Access path is manual.

B14 -- LOW -- UPHELD (+1)
  "Immediately" revocation vs eventually consistent KV; /mcp never re-checks the grant, so expect up to about a minute of lag.

B15 -- LOW -- UPHELD (+1)
  Doc drift: ARCHITECTURE.md still mentions nodemailer (two places) and "No Origin-less POSTs"; coding-rules.md says scope enforcement is v2; OVERVIEW.md "Building milestone 2" and "nothing else reachable". Version string duplicated in server.ts and package.json (currently consistent).

B16 -- LOW -- UPHELD (+1)
  Unauthenticated spike worker in the public repo (not deployed; one wrangler deploy from exposing the mailbox).

B17 -- LOW -- UPHELD (+1)
  preview_urls unset; the Access diagnostics 403 prints iss/aud on any hostname Access does not cover.

B18 -- LOW -- UPHELD (+1)
  Pathological HTML costs seconds of CPU in htmlToText and stripActiveContent. Cubic, not quadratic: 12 KB took 1.2 s, 24 KB 9.8 s, 48 KB 76.8 s. Per-message effect only.

B19 -- LOW -- UPHELD (+1)
  Inbound header values unvalidated; a lone CR in a message id reaches the SMTP stream (dotStuff normalises only LF).

B20 -- LOW -- UPHELD (+1)
  Retention: staged bodies live 5 to 15 minutes in D1; D1 Time Travel is 7 days on Free (not 30); audit_log is never purged.

B21 -- LOW -- UPHELD (+1)
  A lost final 250 is reported as SMTP_CONNECT_FAILED although the mail may be delivered, with the token already consumed (duplicate on retry). 200k-char CJK bodies can exceed D1's 2 MB row limit.

B22 -- LOW -- UPHELD (+1)
  OAuth defaults: tokens issued without `resource` are not audience-bound; 30-day refresh expiry is absolute; code redemption is read-then-write without compare-and-swap (needs code plus PKCE verifier to exploit).

B23 -- none -- UPHELD (0)
  Controls verified: single-use client-bound confirm token (atomic DELETE RETURNING); Access JWT iss/aud/exp/signature; same-origin CSRF on operator forms; requireOperator first on every /authorize route; operator-page CSP; client_name escaped; prepared D1 statements throughout; SEND_ENABLED evaluated per request. B1 and B7 show "no permanent delete" and "scope-gated tools" do not fully hold.

F1 -- MEDIUM -- UPHELD (+5)
  message/rfc822 attachments are hidden (listAttachments returns [], has_attachments false) and their inner text can be served as the body, because walkLeaves descends into the nested structure. Fix: treat message/rfc822 as a leaf attachment.

F2 -- LOW -- UPHELD (+1)
  Unbounded address strings; quadratic ADDRESS_RE (1.0 s at 50k chars, 4.3 s at 100k). Authenticated callers only.

F3 -- LOW -- UPHELD (+1)
  No RFC 5322 header folding; To with 50 named recipients or References in a long thread exceed 998 characters per line. Yahoo's response unmeasured.

F4 -- LOW -- UPHELD (+1)
  SDK 1.30.0 carries audit advisories; none reachable in this build; 1.31.0 exists within the caret range.

Missed by both sides:

R1 -- LOW (+1): update_draft is a second, unprompted route for B1; it is annotated non-destructive yet expunges, and contradicts "delete_draft is the only expunge" in ARCHITECTURE.md.
R2 -- LOW (+1): connector lifecycle undocumented: grants hard-expire after 30 days, client records after 90, so each connector needs re-consent monthly and re-registration at 90 days.
R3 -- LOW (+1): token-time scope narrowing is ignored; buildServer reads props.scopes only.
R4 -- LOW (+1, unverified): "Recoverable from Trash" is time-bounded by Yahoo's Trash retention.

## Scoreboard

Finder 68 of 76 claimed (B3 and B12 lowered); plus 4 new items: CRITICAL 2, MEDIUM 6, LOW 22, total 72. Adversary 0. Disagreements settled: B4 TTL is 90 days (Finder right); B18 is cubic (Adversary right); D1 Time Travel is 7 days on Free (Adversary right).

## Action plan

Before tagging, in order:
1. B1 + R1 (S): delete_draft and update_draft fetch flags and require \Draft; move_messages refuses a destination that resolves to \Drafts; regression test for the move-then-delete chain.
2. B2 (S, plus a short live check): omit Bcc from the wire copy, keep it in the Sent copy; test that RCPT includes the Bcc address and DATA does not; with SEND_ENABLED on, send To one own address and Bcc another and inspect headers at both.
3. B7 (S): send tools also require mail.read; scopes test.
4. B6 (S): include body_html in the preview, or drop body_html from the send tools.
5. B8 (S): downloadText reports whether the part was fully received; readBody folds that into truncated; markup-heavy HTML test.
6. F1 (S-M): message/rfc822 is a leaf attachment; test.
7. Docs that contradict reality (S): OVERVIEW.md and ARCHITECTURE.md on what the confirm step enforces; coding-rules.md on scopes; the Origin sentence; the nodemailer mentions; OVERVIEW.md milestone and reachability lines.
8. F4 (S): bump @modelcontextprotocol/sdk to 1.31.0 or later.
9. Operator checks (S): spike worker not deployed; no ACCESS_DEV_BYPASS secret in production; Access policy allows exactly one email; keep SEND_ENABLED off until items 2 and 4 are live-verified.
10. Finish: typecheck, test, e2e, deploy, live B1 regression, bump version in server.ts and package.json, tag.

In 1.0.x: B4 (registration callback capping metadata, limiter keyed on /64, DCR toggle), B3 (bold redirect host, unverified-client banner), B5 hardening, B9 (OPERATOR_EMAIL), B10 (audit columns), B11, B12 (plan or WAF), B13 (CI), B16 (move spike/ out), B17 (preview_urls false), B18 (linear HTML stripping with an input cap), B19, B20 (audit purge), B21 (SMTP_OUTCOME_UNKNOWN), B22/R3 (resource binding, token-time scope), F2 (address length cap), F3 (header folding).

Docs only: B14 wording, B15 drift, B20 retention figure, R2 lifecycle paragraph, R4 Trash retention after verifying.

---

## Outcome (2026-10-12)

Before-tag items 1 to 8 applied and verified (167 unit tests, live e2e PASS, deployed as Worker version e17c0770-a8cc-4387-accc-22a99768f60c, tagged v1.0.0-rc.2):

- B1 + R1: no tool expunges any more. delete_draft moves the draft to Trash and reports trash_folder and trash_uid; update_draft moves the superseded version to Trash and reports old_version_in. The `\Draft` flag requirement the Referee suggested was tried and dropped: Yahoo does not keep the flag on an appended draft, so our own create_draft output failed it in the first live run. With moves only, nothing can be lost either way. Regression test: a message moved into Drafts and then "deleted" ends in Trash with its subject intact, and no `delete:` command is ever issued.
- B2: confirm_send hands SMTP a copy with the Bcc header removed (folded continuations included); Bcc addresses still go in RCPT TO; the Sent copy keeps the header. Unit tests at both the builder and the tool level. The live Bcc check (To one own address, Bcc another, with SEND_ENABLED on) remains for the operator.
- B7: the send group requires mail.read as well as mail.send.
- B6: body_html is part of the preview and the stored row when supplied.
- B8: downloadText reports whether the part was fully received; readBody marks a byte-capped body truncated and appends a marker; tested with a 300 KB markup-heavy part.
- F1: message/rfc822 is a leaf attachment, listed by filename or as message.eml, never descended for a body.
- Docs: OVERVIEW approval paragraph and reachability line, ARCHITECTURE approval mitigation, Origin rule, nodemailer mentions, draft rows, annotation table, error table, scope sentence; coding-rules scope and no-expunge rules; CLAUDE.md and AGENTS.md no-expunge rule; FORHAYDEN lesson.
- F4: @modelcontextprotocol/sdk 1.32.1, plus imapflow 2.4.0, hono 4.13.13, workers-oauth-provider 0.10.4 via pnpm update; pnpm audit clean.
- Operator checks (item 9): spike worker not deployed (404); production secrets are ACCESS_AUD, ACCESS_TEAM_DOMAIN, SEND_ENABLED, YAHOO_APP_PASSWORD, YAHOO_USER (no ACCESS_DEV_BYPASS); the Access policy allowing exactly one email is the operator's to confirm.

Not done, by design: the 1.0.0 tag itself (operator decision after the Bcc live check), and the 1.0.x list.

B9 done the same day: `OPERATOR_EMAIL` is a required secret and `requireOperator` refuses any Access identity that does not match it, case-insensitively, with a 403 that names neither address. Covered by unit tests.

B2 live check done 2026-10-12: the opt-in e2e self-send now carries a Bcc to the same mailbox. The delivered copy (INBOX uid 236610, four Received hops through Yahoo's submission path) has no Bcc header; the Sent copy (uid 156743) keeps it. The spike's new `/headers` route reads raw header blocks for this kind of check.
