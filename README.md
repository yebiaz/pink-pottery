# Pink Pottery · Silent Donation site

A static website for GitHub Pages. The bids are stored in a free Supabase database, and a GitHub Action sends the emails.
If `config.js` has no keys, the site runs in **demo mode**, so you can see it before anything is set up.

## Go live (about 20 minutes)

### 1. Database (Supabase, free)
1. Create a project at https://supabase.com (pick the **Singapore** region, which is closest to Kunshan).
2. Open **SQL Editor → New query**, paste all of `supabase/setup.sql` and click **Run**.
3. Open **Project Settings → API** and copy the **Project URL** and the **anon public** key into `config.js`.
   Also note the **service_role** key for step 3. Keep it secret and never put it in `config.js`.

### 2. Website (GitHub Pages)
1. Make a **public** repo (for example `pink-pottery-auction`) and upload everything in this folder, including the hidden `.github` folder.
2. Open **Settings → Pages → Source: Deploy from a branch → `main` / root**. After about a minute the site is live at
   `https://<your-username>.github.io/pink-pottery-auction/`.
3. Put that link in a QR code at the booth.

### 3. Emails (GitHub Actions + a Gmail account)
1. Turn on 2-step verification for a club Gmail account, then create an **App password**
   (Google Account → Security → App passwords).
2. In the repo, open **Settings → Secrets and variables → Actions**.
   - **Secrets** tab: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SMTP_HOST` = `smtp.gmail.com`, `SMTP_PORT` = `465`,
     `SMTP_USER` = the Gmail address, `SMTP_PASS` = the app password.
   - **Variables** tab: `SITE_URL`, `FROM_NAME` (e.g. `Medic Mindset · Pink Pottery`), `ORGANIZER_EMAIL`,
     `PAYMENT_INFO`, `PICKUP_INFO`.
3. Test it: go to **Actions → Bid emails → Run workflow** and choose mode `digest` with dry run ticked. The log shows every email it *would* send.

Schedule (China time): a bid update goes out every night at **22:00 from Wed to Sun**. Bidding closes **Sun Nov 29 at 24:00**,
and **winner emails go out Mon Nov 30 at 09:00**. The organizer email gets a `winners.csv` with blank `paid` and `picked_up` columns to tick off.

## During the event
- **Paper bids / fixing bids by hand:** in Supabase, open **Table Editor → bids**. It works like a spreadsheet.
  Click **Insert row** to add a paper bid (fill in piece_id, netid and amount, and set source = `booth`).
  To fix a typo, double-click a cell. To cancel a bid, tick `void`. The site picks up changes within 30 seconds.
  Piece IDs (P01, R05 …) are listed in `pieces.json`. It helps to put a little number card next to each piece at the booth.
- **Fake bid?** Snippet 4 cancels it, and the next-highest bid becomes the top bid again.
- **Photos:** each piece lists its photos in `pieces.json` (first = cover, more = slideshow). To change the cover, reorder the list.
  `group` keeps pieces side by side when the list is shuffled (e.g. `"group": "mugs"`). Optional `name` and `funFact` show on the card.
- Changing the deadline? Change it in **both** `config.js` and `supabase/setup.sql` (then re-run the SQL), and also in `scripts/send_emails.py`.

## Files
| File | What it is |
|---|---|
| `index.html`, `style.css`, `app.js` | the site |
| `config.js` | your Supabase keys and the deadline |
| `pieces.json` | list of pieces: names, starting bids, photos |
| `supabase/setup.sql` | database and bidding rules (the deadline and "must beat the top bid" are checked on the server) |
| `supabase/admin-snippets.sql` | copy-paste helpers for organizers |
| `scripts/send_emails.py`, `.github/workflows/emails.yml` | nightly updates and Monday winner emails |
