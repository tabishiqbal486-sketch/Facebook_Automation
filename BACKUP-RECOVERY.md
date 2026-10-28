# Backup and recovery

## Where your data is
Everything is in the `data` folder next to the software:
- `db.json` - the database (customers, orders, catalogue, approved knowledge, history)
- `images\` - product photos
- `backups\` - automatic copies (every hour while running, the last 30 are kept, plus one before any upgrade)
- `admin.key`, `secret.key` - created on first run if you did not set them in `.env`

## Back up
- Press **Settings > Back up now**, or copy the whole `data` folder (and your `.env`) to a USB drive or cloud drive regularly.
- Keep `secret.key` (or SECRET_KEY) with the backup. Without it the saved Facebook Page tokens cannot be read and you must reconnect your Pages (nothing else is lost).

## Restore
1. Close the software.
2. Copy the backed-up `data` folder (or just `db.json` and `images`) back.
3. Start the software.

## Automatic recovery
If `db.json` is damaged, the software restores the newest file from `data\backups` when it starts and says so in **Monitor**.

## Move to another computer
Copy the program folder, your `.env` and the `data` folder, then run `start.bat`.

## Upgrading
Replace the `src` and `public` folders with the new ones and keep `data` and `.env`. The database is migrated safely and a backup named `before-migration` is made first.
