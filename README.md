# Description

Use this script to archive your inactive MailChimp subscribers, by sending a confirmation e-mail and then deleting users, who didn't respond.

## Why use script?

I didn't have a good feeling just deleting inactive subscribers... And there are people who won't get tracked because they don't accept images in their e-mail client. So I designed this script go the safe way.

# Usage

1. **Tag** your inactive subscribers (best by using segements)
1. Send a **campaign** (gets identified by its **date and title**) to your tagged subscribers that includes a **confirmation url** (that shows they want to receive the e-mails).
1. Wait for your subscribers to respond (a week or two)
1. Install and run this script to archive inactive members

# Installation

1. Install node and npm
1. Clone this repo
1. Run `npm install` inside the root project folder to download dependencies
1. Rename ".env-sample" to ".env" and insert your MailChimp API-key after the equal sign
1. Edit the settings at the beginning of main.js (when I'll work on this project again, I'll make a interface, I promise!)
1. Run the script either locally (`npm start` or `node main`) or globally (first run `npm link` once and the `mc-clean`)
1. Confirm that you want to archive the subscribers
1. Wait for the batch process to finish

# License

This project is licensed under the terms of the MIT license.
