import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

/** Shared chrome for the operator-facing HTML pages (consent, connected clients, landing). */
export function page(
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString> | string,
) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          :root {
            color-scheme: light dark;
          }
          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            font-family:
              system-ui,
              -apple-system,
              "Segoe UI",
              sans-serif;
            background: #f4f4f5;
            color: #18181b;
          }
          .card {
            background: #fff;
            border-radius: 12px;
            padding: 2rem;
            max-width: 44rem;
            width: calc(100% - 2rem);
            box-sizing: border-box;
            box-shadow: 0 1px 3px rgb(0 0 0 / 0.15);
          }
          h1 {
            font-size: 1.25rem;
            line-height: 1.4;
            margin: 0 0 1rem;
          }
          ul {
            padding-left: 1.2rem;
            margin: 0.5rem 0 0;
          }
          li {
            margin: 0.5rem 0;
          }
          .muted {
            opacity: 0.7;
            font-size: 0.9rem;
          }
          .notice {
            background: rgb(37 99 235 / 0.1);
            border-radius: 8px;
            padding: 0.6rem 0.8rem;
          }
          .actions {
            display: flex;
            gap: 0.75rem;
            margin-top: 1.5rem;
          }
          button {
            font: inherit;
            padding: 0.6rem 1.2rem;
            border-radius: 8px;
            border: 1px solid transparent;
            cursor: pointer;
          }
          .approve {
            background: #2563eb;
            color: #fff;
          }
          .deny {
            background: transparent;
            border-color: currentColor;
            color: inherit;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 1rem;
          }
          th,
          td {
            text-align: left;
            padding: 0.5rem;
            border-bottom: 1px solid rgb(127 127 127 / 0.25);
            font-size: 0.9rem;
            vertical-align: top;
          }
          td form {
            margin: 0;
          }
          td button {
            padding: 0.3rem 0.7rem;
            font-size: 0.85rem;
          }
          code {
            font-size: 0.9em;
          }
          a {
            color: inherit;
          }
          @media (prefers-color-scheme: dark) {
            body {
              background: #18181b;
              color: #f4f4f5;
            }
            .card {
              background: #27272a;
            }
          }
        </style>
      </head>
      <body>
        <main class="card">${body}</main>
      </body>
    </html>`;
}

/** CSRF guard for operator forms. Browsers always send Sec-Fetch-Site or Origin on POST. */
export function isSameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = req.headers.get("origin");
  return !origin || origin === new URL(req.url).origin;
}
