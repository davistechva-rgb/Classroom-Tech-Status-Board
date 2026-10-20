# Room Tech Status Board

A shared board showing whether the tech in every room is working: projectors, displays, interactive boards, printers, and more. Teachers report a problem in a few taps, the device turns red or amber on the board, and the tech person updates it to "being fixed" and then "fixed." There's also a wall-display mode for the front office or tech office TV.

Made by [Davis Tech Support](https://davis-tech-support.com) in Farmville, Virginia.

## Features
- Rooms grouped by building or hallway, each with its own list of devices
- Teachers report a problem (not working at all, or working with a problem) with a short description and their name
- Device colors update automatically: green working, amber has a problem, red not working, blue being fixed
- An admin PIN for adding rooms and devices, changing statuses, and replying to and closing reports
- An optional staff code so only your staff can see and use the board
- Wall display at `?display`: the problems in big type, refreshed every 20 seconds
- Search and filter by area or status, and a list of open reports

## Deploy on Netlify (required)
The board stores its data with Netlify Blobs, Netlify's built-in storage, so it needs to run on Netlify. There's nothing else to sign up for.

1. Connect this repository in Netlify (**Add new site > Import an existing project**). Leave the build command empty.
2. In **Site configuration > Environment variables**, add:
   - `ADMIN_PIN`: the PIN you'll use to manage the board. Use at least 6 digits.
   - `STAFF_CODE` (optional): a code staff enter once on each device. Leave it out if anyone with the link may view and report.
3. Redeploy (**Deploys > Trigger deploy**). Open the site, press **Admin**, enter your PIN, and add your rooms.

Share the link with staff, bookmark it on Chromebooks, and open `your-site.netlify.app/?display` on an office TV.

## Good to know
- Fixed reports stay visible for 30 days, then drop off the board.
- If two people save at the same moment, the server retries so neither change is lost.
- The function is in `netlify/functions/board.mjs`. It checks the PIN on the server for every admin action, limits text lengths, and slows down wrong PIN attempts.

## License
The code is MIT licensed; see [LICENSE](LICENSE). The Davis Tech Support name and logo are not covered by that license; see [TRADEMARKS.md](TRADEMARKS.md).

## Contact
Davis Tech Support · [davis-tech-support.com](https://davis-tech-support.com) · davis.tech.va@gmail.com · 434-294-4456
