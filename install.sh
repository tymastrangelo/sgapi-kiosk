#!/bin/bash
# install.sh — run this ONCE on the Pi to set everything up
set -e

USER_NAME=$(whoami)
APP_DIR="$HOME/sgapi-kiosk"

echo "==> Installing system packages"
sudo apt update
sudo apt install -y nodejs npm chromium unclutter

echo "==> Installing Node dependencies"
cd "$APP_DIR"
npm install --omit=dev

echo "==> Installing systemd service"
# Patch the service file with the actual username/path, then install it
sed "s|tymastrangelo|$USER_NAME|g" sgapi-kiosk.service | sudo tee /etc/systemd/system/sgapi-kiosk.service > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable sgapi-kiosk.service
sudo systemctl restart sgapi-kiosk.service

echo "==> Setting up Chromium kiosk autostart"
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/sgapi-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=sgapi kiosk
Exec=/bin/bash -c "sleep 8 && xset s off && xset -dpms && xset s noblank && unclutter -idle 1 -root & chromium --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble --disable-features=TranslateUI --check-for-update-interval=31536000 --autoplay-policy=no-user-gesture-required http://localhost:8080/kiosk"
X-GNOME-Autostart-enabled=true
EOF

echo ""
echo "==> Done!"
echo ""
echo "Admin panel:  http://$(hostname).local:8080/"
echo "              http://$(hostname -I | awk '{print $1}'):8080/"
echo ""
echo "Service status:"
sudo systemctl status sgapi-kiosk.service --no-pager -l | head -n 10
echo ""
echo "Reboot the Pi now to start the kiosk display:  sudo reboot"
