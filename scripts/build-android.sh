#!/usr/bin/env bash
# Build the WGO Android app (home-screen widget) and stage it for the dashboard to serve:
#   dashboard/public/downloads/wgo-android.apk   + android.json (version, size, sha256)
#
#   ./scripts/build-android.sh
#
# Needs JDK 17+ and the Android SDK (platform 35, build-tools). Looked up in $JAVA_HOME / $ANDROID_HOME,
# then ~/.local/opt/jdk17 and ~/Android/Sdk. Exits with code 3 if the toolchain is missing.
#
# Signing: the first build creates android/keystore/release.jks with a random password
# (android/keystore/keystore.properties). Every later build must be signed with the same key, or phones
# refuse the update. Back that directory up somewhere safe. It is gitignored.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="$ROOT/android"
OUT_DIR="$ROOT/dashboard/public/downloads"

step() { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }

if [ -z "${JAVA_HOME:-}" ]; then
  if [ -x "$HOME/.local/opt/jdk17/bin/java" ]; then export JAVA_HOME="$HOME/.local/opt/jdk17"
  elif command -v java >/dev/null; then export JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")"
  fi
fi
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "$JAVA_HOME/bin/java" ] || [ ! -d "$ANDROID_HOME/platforms" ]; then
  echo "Android toolchain not found (need JDK 17+ in JAVA_HOME and the Android SDK in ANDROID_HOME)." >&2
  exit 3
fi

KEY_DIR="$ANDROID_DIR/keystore"
if [ ! -f "$KEY_DIR/keystore.properties" ]; then
  step "Creating release signing key (first build)"
  mkdir -p "$KEY_DIR"
  PASS="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
  "$JAVA_HOME/bin/keytool" -genkeypair -v -keystore "$KEY_DIR/release.jks" -alias wgo \
    -keyalg RSA -keysize 4096 -validity 36500 -storepass "$PASS" -keypass "$PASS" \
    -dname "CN=WGO Android, O=WGO" >/dev/null 2>&1
  cat > "$KEY_DIR/keystore.properties" <<PROPS
storeFile=release.jks
storePassword=$PASS
keyAlias=wgo
keyPassword=$PASS
PROPS
  chmod 600 "$KEY_DIR"/*
  printf '\033[1;33m! Back up %s. Without it you cannot ship updates to installed apps.\033[0m\n' "$KEY_DIR"
fi

step "Android: assemble release"
# minutes since the epoch: every build installs as an upgrade over the previous one
VERSION_CODE=$(( $(date +%s) / 60 ))
cd "$ANDROID_DIR"
./gradlew --quiet :app:assembleRelease -Pwgo.versionCode="$VERSION_CODE"

APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
VERSION_NAME="$(grep '^wgo.versionName=' gradle.properties | cut -d= -f2)"
APP_ID="$(grep '^wgo.applicationId=' gradle.properties | cut -d= -f2)"
mkdir -p "$OUT_DIR"
cp "$APK" "$OUT_DIR/wgo-android.apk"
SIZE=$(stat -c %s "$OUT_DIR/wgo-android.apk")
SHA=$(sha256sum "$OUT_DIR/wgo-android.apk" | cut -d' ' -f1)
CERT_SHA=$("$JAVA_HOME/bin/keytool" -list -v -keystore "$KEY_DIR/release.jks" -alias wgo \
  -storepass "$(grep '^storePassword=' "$KEY_DIR/keystore.properties" | cut -d= -f2)" 2>/dev/null | awk '/SHA256:/ {print $2; exit}')
cat > "$OUT_DIR/android.json" <<JSON
{
  "file": "wgo-android.apk",
  "applicationId": "$APP_ID",
  "versionName": "$VERSION_NAME",
  "versionCode": $VERSION_CODE,
  "size": $SIZE,
  "sha256": "$SHA",
  "certSha256": "$CERT_SHA",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
printf '\033[1;32m✔ %s (%s KB) → %s\033[0m\n' "wgo-android.apk $VERSION_NAME" "$((SIZE / 1024))" "$OUT_DIR"
