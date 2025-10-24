# Repro React SDK Demo

This demo application showcases an authenticated recording workflow. Users must provide
an email and access token before they can start a recording session.

## Getting started

1. Install dependencies
   ```bash
   npm install
   ```
2. Run the development server
   ```bash
   npm run dev
   ```

The recorder UI loads at `http://localhost:5173`.

## Authentication flow

* Click **Log in** to open the authentication modal.
* Enter the email and token that were provisioned for your app.
* The login request is sent to `http://localhost:4000/v1/apps/APP_bddcadcb-c70f-45fa-90f6-56413786f9b3/users/login`
  with the `x-app-user-token` header and the same credentials in the request body.
* On a successful (2xx) response the returned user payload, email, and token are stored
  in `localStorage` under the `app-user-auth` key.
* Once authenticated the **Start recording** button becomes interactive. Attempting to
  record while logged out automatically prompts for credentials.

## Styling

The record button uses a neutral, squared-off aesthetic with animated hover and active
states. The login modal provides a focused workflow for supplying the required
credentials.
