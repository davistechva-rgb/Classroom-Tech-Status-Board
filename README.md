# Room Tech Status Board

A shared board that shows whether the tech in every classroom is working: projectors, displays, interactive boards, Chromebook and iPad carts, printers, and more. Each teacher has their own username and password. They report a problem from their room in a few taps, the device turns red or amber on the board, and the tech person replies, marks it "working on it," and then "fixed." There's also a wall display for the front office or tech office TV.

Made by [Davis Tech Support](https://davis-tech-support.com) in Farmville, Virginia.

## Features
- **Sign in with Google** (optional) for schools on Google Workspace, alongside usernames and passwords.
- **Accounts:** the admin creates accounts (one at a time or many at once) and prints login slips with a temporary password. Each person chooses their own password the first time they sign in and can change it any time. Forgotten passwords are reset by an admin.
- **Three roles:** *Teacher* only sees the rooms assigned to them on the People page, and reports problems there. *Tech* sees every room and manages rooms, devices, and tickets. *Admin* sees everything and also manages accounts.
- **My room:** each teacher is assigned one or more rooms and lands on them when they sign in.
- **Device tiles:** icons for 15 kinds of devices, including Chromebook and iPad carts. Colors show the status: green working, amber has a problem, red not working, blue being fixed. Each device can store a model, serial number, asset tag, location in the room, and private notes, and keeps its ticket history.
- **Tickets with replies:** every report is a conversation between the teacher and the tech. Teachers see a dot when there's a new reply. Tickets can be assigned and marked Open, Working on it, Waiting on parts, or Fixed.
- **Email alerts:** techs and admins get an email when a problem is reported (every report, only "Not working", or never). Teachers get one when someone replies or their ticket is fixed. Each person picks what they get under **My settings**.
- **Photos:** teachers can add a photo to a report or a reply, straight from a phone or Chromebook camera.
- **QR stickers:** print a sticker for each room or each device. Scanning it opens the report form with the room and device already picked.
- **Notices:** post planned outages ("Wi-Fi down in Upper School until 3:30") so everyone sees them before reporting.
- **Warranty and lamp tracking:** add purchase dates, warranty end dates, and projector lamp hours. A morning email gives a heads-up 30 days before a warranty ends and when a lamp reaches 90%, and on Mondays it lists tickets open more than a week.
- **Reports:** problems per month, average time to fix, the devices and rooms with the most problems, what's coming up, plus inventory and ticket spreadsheets for Excel or Google Sheets.
- **UniFi monitoring** (optional): access points and switches turn red and open a ticket on their own when UniFi says they're offline, then close it when they're back.
- **Quick fixes:** when a teacher reports a problem, the form first shows a few steps to try for that kind of device ("Press Source on the remote"). If one works, they tap **That fixed it** and no ticket is made. Edit the steps from **Board → Quick fixes**. Reports counts how many problems teachers fixed themselves.
- **Loaners:** list the Chromebooks, chargers, hotspots, and other things you lend out, check them out to staff or students with a due date, and check them back in (good, damaged, or missing parts). Overdue items stand out, show up in the morning email, and teachers see what they've borrowed on their own page.
- **Walkthroughs:** a phone-friendly room-by-room checklist for summer or monthly checks. Tap ✓ or ✗ on each device, and every ✗ becomes a ticket automatically. Download the results as a spreadsheet.
- **Wall display:** private links (made on the People page) show problems in big type with no sign-in and refresh every 20 seconds.
- **Activity log**, search, and filtering by area or status.

## Deploy on Netlify (required)
The board stores its data with Netlify Blobs, Netlify's built-in storage, so it needs to run on Netlify. There's nothing else to sign up for.

1. Connect this repository in Netlify (**Add new site > Import an existing project**). Leave the build command empty.
2. In **Site configuration > Environment variables**, add `ADMIN_PIN`: a long PIN or phrase only you know. It's used to create the first admin account and to recover admin access. It isn't used for daily sign-in.
3. Redeploy (**Deploys > Trigger deploy**).
4. Open the site. The first visit shows **Set up your board**: enter your ADMIN_PIN, then choose your own admin username and password.
5. Add your rooms on the Board, then add your teachers on **People**.

### Turn on email alerts with Microsoft 365 (optional)
The board sends email through Microsoft Graph, the method Microsoft supports now that basic SMTP sign-in is retired in Exchange Online. You need a Microsoft 365 admin account for steps 1 to 4.

1. **Pick a mailbox to send from.** A shared mailbox works and needs no license, for example `techalerts@yourschool.org` (Exchange admin center > Recipients > Mailboxes > Add a shared mailbox).
2. **Register the app.** Go to **entra.microsoft.com > Applications > App registrations > New registration**. Name it "Room Tech Status", keep "Accounts in this organizational directory only", and press **Register**. Copy the **Application (client) ID** and the **Directory (tenant) ID** from the Overview page.
3. **Give it permission to send mail.** Open **API permissions > Add a permission > Microsoft Graph > Application permissions**, check **Mail.Send**, press **Add permissions**, then **Grant admin consent**.
4. **Make a secret.** Open **Certificates & secrets > New client secret**, pick 24 months, and copy the **Value** right away (it is only shown once). Put a reminder on your calendar to renew it before it expires.
5. **Add four settings in Netlify** under **Site configuration > Environment variables**:
   - `MS_TENANT_ID`: the Directory (tenant) ID
   - `MS_CLIENT_ID`: the Application (client) ID
   - `MS_CLIENT_SECRET`: the secret Value
   - `MAIL_FROM`: the mailbox from step 1
6. **Redeploy.** On the board, open **My settings**, enter your email, and press **Send me a test email**. If something is wrong, the message tells you what Microsoft said.

**Locking it down (recommended):** the Mail.Send application permission lets the app send as any mailbox in your organization. Only the board uses it, and the secret stays in Netlify. To limit it to just the alerts mailbox, use Exchange Online's *Role Based Access Control for Applications* (search for that name on Microsoft Learn) and scope the "Application Mail.Send" role to the alerts mailbox.

**Other email services:** set `SMTP_USER` and `SMTP_PASS` (plus `SMTP_HOST` and `SMTP_PORT`) for a regular SMTP server, or `RESEND_API_KEY` and `MAIL_FROM` for Resend.com. `MAIL_NAME` changes the sender name (the default is Room Tech Status).

The morning heads-up email runs every day at 7 AM Eastern from `netlify/functions/daily.mjs`. It only sends when something needs attention.

### Turn on Sign in with Google (optional)
Teachers can tap **Sign in with Google** instead of typing a password. The board matches their Google email to the email on their account (People → Edit), so add everyone's email first.

1. Go to **console.cloud.google.com**, signed in with your school Google Workspace account. Create a project named "Room Tech Status".
2. Open **Google Auth Platform** (or APIs & Services > OAuth consent screen) and press **Get started**. App name: Room Tech Status. Pick your support email. Under **Audience**, choose **Internal**, so only accounts in your school can use it. Finish and press **Create**.
3. Go to **Clients > Create client**. Application type: **Web application**. Under **Authorized JavaScript origins**, add your board's address, for example `https://classroom-tech-board.netlify.app` (add your custom domain too if you have one). No redirect URI is needed. Press **Create** and copy the **Client ID**, which ends in `.apps.googleusercontent.com`. You don't need the client secret.
4. In Netlify, add `GOOGLE_CLIENT_ID` (the Client ID) and `GOOGLE_DOMAIN` (your Google Workspace domain, for example `fuquaschool.org`). Leave **Contains secret values** unchecked for both, then redeploy.

The sign-in page now shows a Google button above the username form. On the People page, the **Sign in with Google** card can let staff who don't have an account yet join on their own. They start as teachers with no rooms until you assign some. Usernames and passwords keep working either way.

### Connect UniFi (optional)
The board can watch your UniFi access points and switches through Ubiquiti's cloud (the UniFi Site Manager API, which can only read status, never change anything). When a linked device has been offline for two checks in a row (about 10 minutes), its tile turns red, a ticket opens, and techs and admins get the usual "Not working" email. When it comes back online, the ticket closes itself.

1. Sign in at **unifi.ui.com** with an account that can see your school's site. Your console (UDM, Cloud Gateway, or Cloud Key) has to show up there.
2. Go to **Settings > API > Create API Key** and copy the key right away. It's only shown once.
3. In Netlify, add `UNIFI_API_KEY` with that key (it's fine to mark this one secret), then redeploy.
4. On the board, press **📡 UniFi**. Pick which board device each access point or switch belongs to, or choose **+ Add it to (room)**. Names that include a room name or number are suggested for you.

The check runs every 5 minutes from `netlify/functions/unifi.mjs`. You can also link one device at a time from **Edit details** on that device.

### Upgrading from version 1
Your rooms, devices, and open reports carry over. `STAFF_CODE` is no longer used, so you can delete it. Keep `ADMIN_PIN`.

## Good to know
- Locked out? Use **Admin recovery** on the sign-in screen with your ADMIN_PIN to set a new admin password.
- Passwords are stored as scrypt hashes, never as plain text. Six wrong passwords lock that account for 10 minutes.
- Changing or resetting a password, or turning an account off, signs that person out everywhere.
- "Keep me signed in" lasts 30 days. Otherwise sign-in lasts until the browser closes, or one day at most.
- Fixed tickets stay listed for 45 days.
- If two people save at the same moment, the server retries so neither change is lost.

## Credits
Device icons are from [Tabler Icons](https://tabler.io/icons) (MIT license, see TABLER-LICENSE). QR codes are made with qrcode-generator by Kazuhiko Arase (MIT license, included in assets/qrcode.js).

## License
The code is MIT licensed; see [LICENSE](LICENSE). The Davis Tech Support name and logo are not covered by that license; see [TRADEMARKS.md](TRADEMARKS.md).

## Contact
Davis Tech Support · [davis-tech-support.com](https://davis-tech-support.com) · davis.tech.va@gmail.com · 434-294-4456
