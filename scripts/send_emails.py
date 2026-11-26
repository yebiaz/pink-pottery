#!/usr/bin/env python3
"""
Pink Pottery email sender (runs from GitHub Actions; standard library only).

  python scripts/send_emails.py digest  [--dry-run]   # nightly "where your bids stand"
  python scripts/send_emails.py winners [--dry-run]   # Monday: winners + organizer summary

Environment variables (set as GitHub repo secrets):
  SUPABASE_URL, SUPABASE_SERVICE_KEY      service_role key — secret, never put it in the website
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
  FROM_NAME          e.g. "Medic Mindset · Pink Pottery"
  TEST_TO            if set, EVERY email goes only to this address (for testing)
  SITE_URL           e.g. https://yourname.github.io/pink-pottery-auction/
  ORGANIZER_EMAIL    gets the full winners list as a CSV (optional)
  PAYMENT_INFO       how winners pay (e.g. "WeChat Pay / Alipay QR at the booth")
  PICKUP_INFO        where & when to collect
"""
import csv, html, io, json, os, smtplib, ssl, sys, time, urllib.request
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from email.message import EmailMessage
from pathlib import Path

CST = timezone(timedelta(hours=8))
DEADLINE = datetime(2026, 11, 30, 0, 0, tzinfo=CST)
ROOT = Path(__file__).resolve().parent.parent
env = lambda k, d="": os.environ.get(k, d).strip()


def load_pieces():
    data = json.loads((ROOT / "pieces.json").read_text(encoding="utf-8"))
    return {p["id"]: p for p in data.get("ribbons", []) + data.get("pieces", [])}


def title(pieces, pid):
    p = pieces.get(pid, {})
    if p.get("name"): return f'{p["name"]} ({pid})'
    n = int("".join(c for c in pid if c.isdigit()) or 0)
    return ("Ribbon " if pid.startswith("R") else "Piece ") + str(n)


def load_bids():
    from urllib.parse import urlsplit
    u = env("SUPABASE_URL")
    if "://" not in u: u = "https://" + u
    p = urlsplit(u); base = f"{p.scheme}://{p.netloc}"
    url = base + "/rest/v1/bids?select=*&void=eq.false&order=amount.desc,created_at.asc&limit=10000"
    key = env("SUPABASE_SERVICE_KEY")
    h = {"apikey": key}
    if key.startswith("eyJ"):  # legacy service_role JWT; new sb_secret_ keys go in apikey only
        h["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def top_bids(bids):
    """piece_id -> winning bid row (highest amount, earliest wins a tie)."""
    top = {}
    for b in sorted(bids, key=lambda b: (-b["amount"], b["created_at"])):
        top.setdefault(b["piece_id"], b)
    return top


# ---------------------------------------------------------------- email plumbing
def wrap(title, inner):
    site = env("SITE_URL")
    btn = f'<p style="margin:24px 0"><a href="{html.escape(site)}" style="background:#e8578d;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:bold;display:inline-block">Open Pink Pottery</a></p>' if site else ""
    return f"""<!doctype html><html><body style="margin:0;background:#fff5f8;font-family:Georgia,serif;color:#1d1418">
<div style="max-width:560px;margin:0 auto;padding:24px">
 <div style="background:#f8c8d9;border:3px solid #e8578d;border-radius:6px;padding:18px 20px">
  <div style="font-size:13px;letter-spacing:.08em;color:#b02a60;font-family:Arial,sans-serif;font-weight:bold">PINK POTTERY · SILENT DONATION</div>
  <h1 style="margin:6px 0 0;font-style:italic;font-size:24px">{html.escape(title)}</h1>
 </div>
 <div style="background:#fff;border:2px solid #f0c2d3;border-radius:12px;padding:18px 20px;margin-top:14px;font-size:16px;line-height:1.55">{inner}{btn}</div>
 <p style="font-size:12px;color:#7a6870;text-align:center;margin-top:16px;font-family:Arial,sans-serif">Every yuan goes to patients at the Breast Cancer Ward, Kunshan No. 1 Hospital.<br>Medic Mindset × Ceramics Club</p>
</div></body></html>"""


def table(rows):
    tr = "".join(
        f'<tr><td style="padding:8px 6px;border-bottom:1px dashed #f0c2d3">{html.escape(a)}</td>'
        f'<td style="padding:8px 6px;border-bottom:1px dashed #f0c2d3;text-align:right;white-space:nowrap">{b}</td></tr>'
        for a, b in rows)
    return f'<table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:15px">{tr}</table>'


class Mailer:
    def __init__(self, dry):
        self.dry, self.sent, self.smtp = dry, 0, None

    def __enter__(self):
        if not self.dry:
            port = int(env("SMTP_PORT", "465"))
            host = env("SMTP_HOST", "smtp.gmail.com")
            ctx = ssl.create_default_context()
            if port == 465:
                self.smtp = smtplib.SMTP_SSL(host, port, context=ctx, timeout=30)
            else:
                self.smtp = smtplib.SMTP(host, port, timeout=30); self.smtp.starttls(context=ctx)
            self.smtp.login(env("SMTP_USER"), env("SMTP_PASS"))
        return self

    def __exit__(self, *a):
        if self.smtp: self.smtp.quit()

    def send(self, to, subject, html_body, text_body, attachment=None, inline=None):
        test_to = env("TEST_TO")
        if test_to:  # test mode: everything goes to one inbox, nobody else gets anything
            if self.sent >= 5:
                print(f"  (test mode: skipping more emails after 5; would go to {to})"); return
            subject = f"[TEST, would go to {to}] {subject}"
            to = test_to
        if self.dry:
            print(f"--- [dry run] To: {to}\n    Subject: {subject}\n    {text_body[:300].replace(chr(10), chr(10) + '    ')}\n")
            return
        msg = EmailMessage()
        msg["From"] = f'{env("FROM_NAME", "Pink Pottery")} <{env("SMTP_USER")}>'
        msg["To"] = to
        msg["Subject"] = subject
        msg.set_content(text_body)
        plain = env("PLAIN_TEXT").lower() in ("true", "yes", "1")
        if not plain:
            msg.add_alternative(html_body, subtype="html")
        else:
            inline = None  # plain text can't show an inline image
        if inline:  # (path, cid): image shown inside the email body
            path, cid = inline
            ext = Path(path).suffix.lstrip(".").lower().replace("jpg", "jpeg")
            msg.get_payload()[1].add_related(Path(path).read_bytes(), maintype="image", subtype=ext, cid=f"<{cid}>")
        if attachment:
            name, data = attachment
            msg.add_attachment(data.encode("utf-8-sig"), maintype="text", subtype="csv", filename=name)
        for attempt in range(3):
            try:
                self.smtp.send_message(msg); self.sent += 1; time.sleep(1.2); return
            except smtplib.SMTPException as e:
                print(f"  retry {attempt + 1} for {to}: {e}"); time.sleep(5)
        print(f"!! FAILED to send to {to}")


# ---------------------------------------------------------------- modes
SIGNOFF_HTML = "<p>Many thanks and have fun,<br><b>DKU Ceramics Club and Medic Mindset</b></p>"
QR_PATH = ROOT / "images" / "hospital-qr.png"
HOSPITAL_QUOTE = "谢谢你们，非常感谢，我代那些病人向你们表示衷心感谢。"


def time_left(now):
    secs = max(0, int((DEADLINE - now).total_seconds()))
    d, h = secs // 86400, secs % 86400 // 3600
    if d: return f"{d} day{'s' if d != 1 else ''} and {h} hour{'s' if h != 1 else ''}"
    if h: return f"{h} hour{'s' if h != 1 else ''}"
    return "less than an hour"


def and_list(xs):
    return xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + " and " + xs[-1]


def digest(bids, pieces, dry):
    """Evening update: ONE email per bidder, covering pieces they're winning and pieces they've been outbid on."""
    now = datetime.now(CST)
    if now >= DEADLINE and "--force" not in sys.argv and not env("TEST_TO"):
        print("Bidding has closed; skipping digest."); return
    top = top_bids(bids)
    mine = defaultdict(dict)  # netid -> piece -> my highest bid
    for b in bids:
        mine[b["netid"]][b["piece_id"]] = max(b["amount"], mine[b["netid"]].get(b["piece_id"], 0))
    left = time_left(now)
    is_are = "is" if left.startswith(("1 ", "less")) else "are"
    n_out = n_win = 0
    with Mailer(dry) as m:
        for netid, items in sorted(mine.items()):
            lost = sorted(pid for pid in items if top[pid]["netid"] != netid)
            won = sorted(pid for pid in items if top[pid]["netid"] == netid)
            n_out += bool(lost); n_win += bool(won and not lost)
            parts_h, parts_t = [], []
            if lost:
                names = and_list([title(pieces, pid) for pid in lost])
                rows = [(title(pieces, pid), f'top bid now <b style="color:#b02a60">¥{top[pid]["amount"]}</b> <span style="color:#7a6870">(yours: ¥{items[pid]})</span>') for pid in lost]
                parts_h.append(f"<p>You have been outbid for the <b>{html.escape(names)}</b> ceramic{'s' if len(lost) > 1 else ''}.</p>{table(rows)}")
                parts_t.append(f"You have been outbid for the {names} ceramic{'s' if len(lost) > 1 else ''}.\n" +
                               "".join(f"- {title(pieces, pid)}: top bid now ¥{top[pid]['amount']} (yours: ¥{items[pid]})\n" for pid in lost))
            if won:
                names = and_list([title(pieces, pid) for pid in won])
                rows = [(title(pieces, pid), f'your bid <b style="color:#2f8f5b">¥{items[pid]}</b> is the top bid') for pid in won]
                parts_h.append(f"<p>You are currently the top bidder for the <b>{html.escape(names)}</b> ceramic{'s' if len(won) > 1 else ''}.</p>{table(rows)}")
                parts_t.append(f"You are currently the top bidder for the {names} ceramic{'s' if len(won) > 1 else ''}.\n" +
                               "".join(f"- {title(pieces, pid)}: your bid ¥{items[pid]} is the top bid\n" for pid in won))
            inner = (f"<p>Dear {html.escape(netid)},</p>" + "".join(parts_h) +
                     f"<p>There {is_are} <b>{left}</b> left before bidding closes (Sunday, Nov 29 at midnight)! "
                     "You can check or raise your bids any time on the website.</p>"
                     "<p>Thank you for your time and have a great day!</p>" + SIGNOFF_HTML)
            text = (f"Dear {netid},\n\n" + "\n".join(parts_t) +
                    f"\nThere {is_are} {left} left before bidding closes (Sunday, Nov 29 at midnight)! "
                    f"You can check or raise your bids any time on the website: {env('SITE_URL')}\n\n"
                    "Thank you for your time and have a great day!\n\nMany thanks and have fun,\nDKU Ceramics Club and Medic Mindset\n")
            subject = "Pink Pottery: you've been outbid" if lost else "Pink Pottery: you're the top bidder"
            m.send(f"{netid}@duke.edu", subject, wrap("Your evening bid update", inner), text)
    print(f"Evening update: {len(mine)} bidders ({n_out} outbid on something, {n_win} winning everything), {0 if dry else m.sent} emails sent.")


def winners(bids, pieces, dry):
    if datetime.now(CST) < DEADLINE and "--force" not in sys.argv and not env("TEST_TO"):
        print("Bidding hasn't closed yet; refusing to send winner emails (use --force to override)."); return
    top = top_bids(bids)
    by_person = defaultdict(list)
    for pid, b in top.items():
        by_person[b["netid"]].append(b)
    pay = env("PAYMENT_INFO", "Pay at the Medic Mindset booth by WeChat Pay or Alipay.")
    pickup = env("PICKUP_INFO", "Pick up your piece at the Performance Cafe. We'll confirm the time by email.")

    with Mailer(dry) as m:
        for netid, won in sorted(by_person.items()):
            won.sort(key=lambda b: b["piece_id"])
            total = sum(b["amount"] for b in won)
            first = netid
            rows = [(title(pieces, b["piece_id"]), f'<b>¥{b["amount"]}</b>') for b in won]
            rows.append(("Total donation", f'<b style="color:#b02a60">¥{total}</b>'))
            inner = (f"<p>Hi {html.escape(first)},</p><p>Bidding has closed and <b>you won!</b> 🎉</p>{table(rows)}"
                     f"<h3 style='color:#b02a60;margin-bottom:4px'>How to pay</h3><p style='margin-top:0'>{html.escape(pay)}</p>"
                     f"<h3 style='color:#b02a60;margin-bottom:4px'>Pick-up</h3><p style='margin-top:0'>{html.escape(pickup)}</p>"
                     "<p>Please bring this email (or your NetID) when you collect. Your entire donation goes to patients "
                     "in the Breast Cancer Ward at Kunshan No. 1 Hospital. Thank you so much!</p>")
            text = (f"Hi {first},\n\nBidding has closed and you won:\n" +
                    "\n".join(f'- {title(pieces, b["piece_id"])}: ¥{b["amount"]}' for b in won) +
                    f"\nTotal donation: ¥{total}\n\nHow to pay: {pay}\nPick-up: {pickup}\n\nThank you!\n")
            m.send(f"{netid}@duke.edu", f"You won {len(won)} Pink Pottery piece{'s' if len(won) > 1 else ''}! Total ¥{total}",
                   wrap("Congratulations, you won!", inner), text)

        # people who bid but didn't win (one email listing every piece they missed)
        grand_total = sum(b["amount"] for b in top.values())
        bid_on = defaultdict(set)
        for b in bids: bid_on[b["netid"]].add(b["piece_id"])
        qr = QR_PATH if QR_PATH.exists() else None
        for netid, pids in sorted(bid_on.items()):
            lost = sorted(pid for pid in pids if top[pid]["netid"] != netid)
            if not lost: continue
            names = and_list([title(pieces, pid) for pid in lost])
            qr_html = ("<p>Some event participants told us they would like to donate even if they did not place the top bid, "
                       "so we're including the hospital's QR code below:</p>"
                       '<p style="text-align:center"><img src="cid:hospitalqr" alt="Hospital donation QR code" style="width:220px;max-width:100%"></p>') if qr else ""
            inner = (f"<p>Dear {html.escape(netid)},</p>"
                     f"<p>We want to let you know that you did not place the final bid for the <b>{html.escape(names)}</b> ceramic{'s' if len(lost) > 1 else ''}. "
                     "Thank you for your participation, and we hope you enjoyed the auction!</p>" + qr_html +
                     "<p>The hospital representative sends her appreciation to you:</p>"
                     f'<blockquote style="margin:8px 0;padding:8px 14px;border-left:4px solid #e8578d;background:#fff5f8">“{HOSPITAL_QUOTE}”</blockquote>'
                     "<p>Any donation goes directly to the hospital's breast cancer ward. To our knowledge, there are about 75 patients on the ward "
                     "that we visited, including women, men, young adults and elders.</p>"
                     f"<p>Altogether, the event raised <b>¥{grand_total}</b> from the ceramics, not including students and faculty who donated without bidding on a piece. "
                     "We genuinely appreciate everyone's participation, big or small. We came together to express solidarity with patients.</p>"
                     "<p>Much appreciation,<br><b>Medic Mindset and DKU Ceramics Club</b></p>")
            text = (f"Dear {netid},\n\nWe want to let you know that you did not place the final bid for the {names} ceramic{'s' if len(lost) > 1 else ''}. "
                    "Thank you for your participation, and we hope you enjoyed the auction!\n\n" +
                    ("If you'd still like to donate, the hospital's QR code is in this email.\n\n" if qr else "") +
                    f"The hospital representative sends her appreciation to you: “{HOSPITAL_QUOTE}”\n\n"
                    "Any donation goes directly to the hospital's breast cancer ward. To our knowledge, there are about 75 patients on the ward that we visited, "
                    "including women, men, young adults and elders.\n\n"
                    f"Altogether, the event raised ¥{grand_total} from the ceramics, not including students and faculty who donated without bidding on a piece. "
                    "We genuinely appreciate everyone's participation, big or small.\n\nMuch appreciation,\nMedic Mindset and DKU Ceramics Club\n")
            m.send(f"{netid}@duke.edu", "Thank you for bidding in Pink Pottery 💗", wrap("Thank you for taking part", inner), text,
                   inline=(str(qr), "hospitalqr") if qr else None)

        # organizer summary + CSV
        buf = io.StringIO(); w = csv.writer(buf)
        w.writerow(["piece_id", "piece", "winning_bid_rmb", "netid", "email", "source", "bid_time_china", "paid", "picked_up"])
        for pid in sorted(top, key=lambda x: (x[0], int("".join(c for c in x if c.isdigit()) or 0))):
            b = top[pid]
            t = datetime.fromisoformat(b["created_at"].replace("Z", "+00:00")).astimezone(CST).strftime("%Y-%m-%d %H:%M")
            w.writerow([pid, title(pieces, pid), b["amount"], b["netid"], b["netid"] + "@duke.edu", b.get("source", ""), t, "", ""])
        no_bids = [pid for pid in pieces if pid not in top]
        total = sum(b["amount"] for b in top.values())
        org = env("ORGANIZER_EMAIL")
        summary = (f"{len(top)} pieces sold to {len(by_person)} people, total pledged ¥{total}.\n"
                   f"No bids: {', '.join(no_bids) or 'none'}\nFull list attached (winners.csv).")
        if org:
            m.send(org, f"Pink Pottery results: ¥{total} pledged", wrap("Final results", "<p>" + html.escape(summary).replace("\n", "<br>") + "</p>"),
                   summary, attachment=("winners.csv", buf.getvalue()))
        Path("winners.csv").write_text(buf.getvalue(), encoding="utf-8-sig")
        print(summary)
    print(f"Winners: {len(by_person)} people, {0 if dry else m.sent} emails sent.")


SAMPLE_BIDS = [  # made-up bids: "cd456" is outbid on two pieces and winning one; "ab123" is winning two
    {"piece_id": "P13", "netid": "cd456", "amount": 25, "source": "web", "created_at": "2026-11-26T01:00:00Z"},
    {"piece_id": "P13", "netid": "ab123", "amount": 40, "source": "web", "created_at": "2026-11-26T02:00:00Z"},
    {"piece_id": "R05", "netid": "cd456", "amount": 10, "source": "web", "created_at": "2026-11-26T01:00:00Z"},
    {"piece_id": "R05", "netid": "ab123", "amount": 12, "source": "web", "created_at": "2026-11-26T02:00:00Z"},
    {"piece_id": "P05", "netid": "cd456", "amount": 30, "source": "web", "created_at": "2026-11-26T03:00:00Z"},
]

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "digest"
    dry = "--dry-run" in sys.argv
    if mode == "sample":  # example evening email from made-up bids; never touches real bidders
        if not env("TEST_TO"):
            sys.exit("Sample mode needs a test address (TEST_TO).")
        digest(SAMPLE_BIDS, load_pieces(), dry)
        sys.exit(0)
    pieces, bids = load_pieces(), load_bids()
    {"digest": digest, "winners": winners}[mode](bids, pieces, dry)
