# Orihime MD command media

Command media is no longer read from a WhatsApp Channel. Every supplied image is an individual file at the repository root.

The mapping is defined in `commandMedia.js`. Example: `.menu` reads `15-menu.png`, `.ping` reads `13-ping.png`, and `.promote`/`.demote` intentionally have no image because no dedicated assets were uploaded for them.

To change a command image, replace the mapped root-level file in GitHub with another file using the same filename. No channel join, channel scan, or synchronization step is required.

The `.menu` command sends `15-menu.png` and animates its caption in place before showing the full menu.
