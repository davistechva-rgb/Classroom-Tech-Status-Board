# Room Tech Status Board

A shared board that shows whether the tech in every classroom is working: projectors, displays, interactive boards, Chromebook and iPad carts, printers, and more. Each teacher has their own username and password. They report a problem from their room in a few taps, the device turns red or amber on the board, and the tech person replies, marks it "working on it," and then "fixed." There's also a wall display for the front office or tech office TV.

Made by [Davis Tech Support](https://davis-tech-support.com) in Farmville, Virginia.

## Features
- **Accounts:** the admin creates accounts (one at a time or many at once) and prints login slips with a temporary password. Each person chooses their own password the first time they sign in and can change it any time. Forgotten passwords are reset by an admin.
- **Three roles:** *Teacher* reports problems in their assigned rooms. *Tech* fixes tickets and edits devices in their assigned rooms. *Admin* sees every room, adds and deletes rooms, and manages accounts. Teachers and techs only see the rooms assigned to them on the People page.
- **My room:** each teacher is assigned one or more rooms and lands on them when they sign in.
- **Device tiles:** icons for 15 kinds of devices, including Chromebook and iPad carts. Colors show the status: green working, amber has a problem, red not working, blue being fixed. Each device can store a model, serial number, asset tag, location in the room, and private notes, and keeps its ticket history.
- **Tickets with replies:** every report is a conversation between the teacher and the tech. Teachers see a dot when there's a new reply. Tickets can be assigned and marked Open, Working on it, Waiting on parts, or Fixed.
- **Wall display:** private links (made on the People page) show problems in big type with no sign-in and refresh every 20 seconds.
- **Activity log**, search, and filtering by area or status.

## Deploy on Netlify (required)
The board stores its data with Netlify Blobs, Netlify's built-in storage, so it needs to run on Netlify. There's nothing else to sign up for.

1. Connect this repository in Netlify (**Add new site > Import an existing project**). Leave the build command empty.
2. In **Site configuration > Environment variables**, add `ADMIN_PIN`: a long PIN or phrase only you know. It's used to create the first admin account and to recover admin access. It isn't used for daily sign-in.
3. Redeploy (**Deploys > Trigger deploy**).
4. Open the site. The first visit shows **Set up your board**: enter your ADMIN_PIN, then choose your own admin username and password.
5. Add your rooms on the Board, then add your teachers on **People**.

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
Device icons are from [Tabler Icons](https://tabler.io/icons) (MIT license, see TABLER-LICENSE).

## License
The code is MIT licensed; see [LICENSE](LICENSE). The Davis Tech Support name and logo are not covered by that license; see [TRADEMARKS.md](TRADEMARKS.md).

## Contact
Davis Tech Support · [davis-tech-support.com](https://davis-tech-support.com) · davis.tech.va@gmail.com · 434-294-4456
