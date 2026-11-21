#!/usr/bin/env bash
# Prepare a USB drive as Pinkas's ENCRYPTED backup drive (LUKS2 + ext4). ERASES the drive.
#   lsblk -o NAME,SIZE,MODEL,TRAN,MOUNTPOINTS          # find the USB drive, e.g. sdb
#   sudo bash deploy/setup-usb-backup.sh /dev/sdb
# Unlocking: a random key file on the server (/etc/pinkas-backup.key) so backups need no typing,
# plus a passphrase you choose (write it on paper) to open the drive on another computer if the
# server is lost. The drive mounts on demand at /mnt/pinkas-backup and unmounts after 60s idle,
# so it can be unplugged and stored elsewhere (הוראה 25: quarterly copy kept in a separate place).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
DEV=${1:-}
[ -b "$DEV" ] || { echo "Usage: sudo bash $0 /dev/sdX   (see: lsblk -o NAME,SIZE,MODEL,TRAN)"; exit 1; }

NAME=pinkasbk
MNT=/mnt/pinkas-backup
KEY=/etc/pinkas-backup.key
SVC_USER=pinkas

# ---- safety checks: never the system disk, only a whole USB disk ----
[ "$(lsblk -dno TYPE "$DEV")" = disk ] || { echo "!! $DEV is not a whole disk (use e.g. /dev/sdb, not /dev/sdb1)"; exit 1; }
ROOTDISK=$(lsblk -no PKNAME "$(findmnt -no SOURCE /boot)" | head -1)
[ "$(basename "$DEV")" != "$ROOTDISK" ] || { echo "!! $DEV is the SYSTEM disk. Stopping."; exit 1; }
[ "$(lsblk -dno TRAN "$DEV")" = usb ] || { echo "!! $DEV is not a USB drive. Stopping."; exit 1; }
if lsblk -no MOUNTPOINTS "$DEV" | grep -q .; then echo "!! $DEV (or a partition on it) is mounted. Unmount it first."; exit 1; fi

echo "This drive will be ERASED completely:"
lsblk -o NAME,SIZE,MODEL,TRAN,FSTYPE,LABEL "$DEV"
read -r -p "Type ERASE (capital letters) to continue: " ok
[ "$ok" = ERASE ] || { echo "Cancelled."; exit 1; }

echo "== 1/5 Key file"
if [ ! -f "$KEY" ]; then (umask 077; head -c 4096 /dev/urandom > "$KEY"); fi
chmod 400 "$KEY"; chown root:root "$KEY"

echo "== 2/5 Encrypting (LUKS2)"
cryptsetup close "$NAME" 2>/dev/null || true
wipefs -aq "$DEV"
cryptsetup luksFormat --type luks2 --batch-mode --key-file "$KEY" "$DEV"
echo
echo "Now choose a BACKUP PASSPHRASE for this drive (write it on paper, keep it apart from the drive)."
echo "It is needed only to open the drive on another computer. Typing is hidden."
cryptsetup luksAddKey --key-file "$KEY" "$DEV"

echo "== 3/5 File system"
cryptsetup open --key-file "$KEY" "$DEV" "$NAME"
mkfs.ext4 -q -L pinkas-backup "/dev/mapper/$NAME"
mkdir -p "$MNT"
mount "/dev/mapper/$NAME" "$MNT"
install -d -m 700 -o "$SVC_USER" -g "$SVC_USER" "$MNT/PinkasBackup"
umount "$MNT"
cryptsetup close "$NAME"

echo "== 4/5 Automatic unlock + mount on demand"
UUID=$(blkid -s UUID -o value "$DEV")
sed -i "/^$NAME /d" /etc/crypttab 2>/dev/null || true
echo "$NAME UUID=$UUID $KEY luks,nofail,noauto" >> /etc/crypttab
sed -i "\#[[:space:]]$MNT[[:space:]]#d" /etc/fstab
echo "/dev/mapper/$NAME $MNT ext4 noauto,nofail,noatime,x-systemd.automount,x-systemd.idle-timeout=60,x-systemd.device-timeout=10s,x-systemd.requires=systemd-cryptsetup@$NAME.service 0 2" >> /etc/fstab
systemctl daemon-reload
systemctl restart "$(systemd-escape -p --suffix=automount "$MNT")"

echo "== 5/5 Test"
if [ -d "$MNT/PinkasBackup" ]; then
  echo "   OK: $MNT/PinkasBackup is available"
  df -h "$MNT" | tail -1
else
  echo "!! The drive did not mount. Send this output."; exit 1
fi
echo
echo "DONE. In Pinkas: Backup -> target folder:  $MNT/PinkasBackup  -> Save -> Back up now."
echo "After the backup: wait ~1 minute (auto-unmount), then unplug the drive and store it in another place."
