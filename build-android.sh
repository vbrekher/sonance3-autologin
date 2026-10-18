#!/usr/bin/env bash
# Sonance — Android TV build script (ticket-3.xx-androidtv P1).
#
# Packages the .wgt's web payload into an APK with the Android SDK's own tools, in order: aapt2
# (resources, manifest and assets), javac, d8, zipalign and apksigner. No Gradle, nothing fetched,
# nothing bundled (ticket §2.2).
#
#   ./build-android.sh --debug     android/build/sonance-debug.apk: debuggable, WebView DevTools on,
#                                  signed with android/build/debug.keystore (generated if missing;
#                                  keep it, or `adb install -r` of the next build is refused)
#   ./build-android.sh --release   Sonance3-AndroidTV.apk: not debuggable, DevTools off, signed with
#                                  the user's keystore from SONANCE_KEYSTORE, SONANCE_KEYSTORE_PASS,
#                                  SONANCE_KEY_ALIAS and SONANCE_KEY_PASS, which are never echoed
#
# The web payload is Sonance3.wgt's members minus config.xml and icon.png, byte for byte, so the
# two platforms cannot drift: run ./build.sh first. The shim (android/shim/webapis.js) is added at
# www/$WEBAPIS/webapis/webapis.js, where Tizen serves its WebAPIs. versionName is config.xml's
# version and versionCode is major*10000 + minor*100 + patch, so config.xml stays the one source.
set -e

cd "$(dirname "$0")"

MODE="${1:-}"
case "$MODE" in
    --debug|--release) ;;
    *) echo "usage: ./build-android.sh --debug | --release" >&2; exit 2 ;;
esac

WGT="Sonance3.wgt"
BUILD="android/build"
STAGE="$BUILD/stage"                     # the APK's assets/; www/ is the web payload
SHIM_SRC="android/shim/webapis.js"
SHIM_REL='www/$WEBAPIS/webapis/webapis.js'
MIN_SDK=26
TARGET_SDK=35                            # pinned (G9): at 36, Android 16 stops delivering BACK
PLATFORM="android-35"
BUILD_TOOLS="36.0.0"
DEBUG_APK="$BUILD/sonance-debug.apk"
RELEASE_APK="Sonance3-AndroidTV.apk"

fail() { echo "ERROR: $*" >&2; exit 1; }

echo "============================================"
echo "  Sonance — Build Android TV APK ($MODE)"
echo "============================================"
echo ""

# ----- Toolchain ------------------------------------------------------------

SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="$SDK/build-tools/$BUILD_TOOLS"
ANDROID_JAR="$SDK/platforms/$PLATFORM/android.jar"
if [ -n "${JAVA_HOME:-}" ]; then
    JAVAC="$JAVA_HOME/bin/javac"
    KEYTOOL="$JAVA_HOME/bin/keytool"
else
    JAVAC="$(command -v javac || true)"
    KEYTOOL="$(command -v keytool || true)"
fi

missing=()
for t in aapt2 d8 zipalign apksigner dexdump; do
    [ -x "$BT/$t" ] || missing+=("$BT/$t   (sdkmanager \"build-tools;$BUILD_TOOLS\")")
done
[ -f "$ANDROID_JAR" ] || missing+=("$ANDROID_JAR   (sdkmanager \"platforms;$PLATFORM\")")
[ -n "$JAVAC" ] && [ -x "$JAVAC" ] || missing+=("javac   (a JDK; set JAVA_HOME)")
if [ "$MODE" = "--debug" ]; then
    [ -n "$KEYTOOL" ] && [ -x "$KEYTOOL" ] || missing+=("keytool   (a JDK; set JAVA_HOME)")
fi
if [ ${#missing[@]} -gt 0 ]; then
    echo "ERROR: the Android SDK at $SDK (\$ANDROID_HOME, else ~/Library/Android/sdk) or the JDK lacks:" >&2
    printf '  %s\n' "${missing[@]}" >&2
    exit 1
fi

# A release build needs the user's keystore. Stop before doing any work without it. The values are
# only ever read by apksigner (env: for the passwords), never echoed.
if [ "$MODE" = "--release" ]; then
    unset_vars=()
    for v in SONANCE_KEYSTORE SONANCE_KEYSTORE_PASS SONANCE_KEY_ALIAS SONANCE_KEY_PASS; do
        [ -n "${!v:-}" ] || unset_vars+=("$v")
    done
    if [ ${#unset_vars[@]} -gt 0 ]; then
        echo "ERROR: a release build is signed with your own keystore, and these are not set:" >&2
        printf '  %s\n' "${unset_vars[@]}" >&2
        echo "Set all four (SONANCE_KEYSTORE, SONANCE_KEYSTORE_PASS, SONANCE_KEY_ALIAS, SONANCE_KEY_PASS)," >&2
        echo "or build a debug APK with ./build-android.sh --debug." >&2
        exit 1
    fi
    [ -f "$SONANCE_KEYSTORE" ] || fail "SONANCE_KEYSTORE does not name a file."
fi

# ----- Version (config.xml) -------------------------------------------------

VERSION_NAME="$(perl -ne 'if (/<widget/../>/) { print $1 if /\bversion="(\d+\.\d+\.\d+)"/ }' config.xml | head -1)"
[ -n "$VERSION_NAME" ] || fail "no version=\"X.Y.Z\" found in config.xml."
IFS=. read -r V_MAJOR V_MINOR V_PATCH <<< "$VERSION_NAME"
[ "$V_MINOR" -lt 100 ] && [ "$V_PATCH" -lt 100 ] || fail "versionCode needs minor and patch below 100 ($VERSION_NAME)."
VERSION_CODE=$((V_MAJOR * 10000 + V_MINOR * 100 + V_PATCH))
echo "Version: $VERSION_NAME (versionCode $VERSION_CODE)"

# ----- Web payload ----------------------------------------------------------

[ -f "$WGT" ] || fail "$WGT is missing: run ./build.sh first."
echo "Staging the web payload from ${WGT}…"
rm -rf "$STAGE"
mkdir -p "$STAGE/www"
unzip -q "$WGT" -d "$STAGE/www" -x config.xml icon.png
mkdir -p "$(dirname "$STAGE/$SHIM_REL")"
cp "$SHIM_SRC" "$STAGE/$SHIM_REL"

# Gate: the staged payload is the .wgt's members (minus config.xml and icon.png), byte for byte.
WGT_MEMBERS="$(unzip -Z1 "$WGT" | grep -v '/$' | grep -vxF config.xml | grep -vxF icon.png | LC_ALL=C sort)"
STAGED="$(cd "$STAGE/www" && find . -type f | sed 's|^\./||' | grep -vxF "${SHIM_REL#www/}" | LC_ALL=C sort)"
[ "$WGT_MEMBERS" = "$STAGED" ] || fail "the staged payload's file list differs from $WGT's."
while IFS= read -r m; do
    unzip -p "$WGT" "$m" | cmp -s - "$STAGE/www/$m" || fail "staged $m differs from $WGT."
done <<< "$WGT_MEMBERS"
echo "  payload: $(echo "$WGT_MEMBERS" | wc -l | tr -d ' ') files, identical to $WGT"

# Gate: the shim is there, and parses on Chromium 63.
[ -s "$STAGE/$SHIM_REL" ] || fail "the shim is missing ($SHIM_SRC)."
if grep -nE '\?\.|\?\?' "$SHIM_SRC" >/dev/null; then
    grep -nE '\?\.|\?\?' "$SHIM_SRC" >&2
    fail "the shim contains optional chaining or nullish coalescing (Chromium 63 cannot parse them)."
fi
echo "  shim:    $SHIM_REL"

# ----- Compile and package --------------------------------------------------

rm -rf "$BUILD/res.zip" "$BUILD/classes" "$BUILD/dex" "$BUILD/unsigned.apk" "$BUILD/aligned.apk"

echo "aapt2: compiling resources and linking the manifest and assets…"
"$BT/aapt2" compile --dir android/res -o "$BUILD/res.zip"
LINK=(link -o "$BUILD/unsigned.apk" -I "$ANDROID_JAR" --manifest android/AndroidManifest.xml
      --min-sdk-version "$MIN_SDK" --target-sdk-version "$TARGET_SDK"
      --version-code "$VERSION_CODE" --version-name "$VERSION_NAME"
      -A "$STAGE" "$BUILD/res.zip")
# --debug-mode sets android:debuggable, which MainActivity reads to turn DevTools on (W7).
[ "$MODE" = "--debug" ] && LINK+=(--debug-mode)
"$BT/aapt2" "${LINK[@]}"

echo "javac: --release 17 against ${PLATFORM}…"
JAVA_SRC=()
while IFS= read -r f; do JAVA_SRC+=("$f"); done < <(find android/src -name '*.java' | LC_ALL=C sort)
mkdir -p "$BUILD/classes"
"$JAVAC" --release 17 -encoding UTF-8 -Xlint:all -Xlint:-options \
    -classpath "$ANDROID_JAR" -d "$BUILD/classes" "${JAVA_SRC[@]}"

echo "d8: --min-api ${MIN_SDK}…"
CLASSES=()
while IFS= read -r f; do CLASSES+=("$f"); done < <(find "$BUILD/classes" -name '*.class' | LC_ALL=C sort)
mkdir -p "$BUILD/dex"
if [ "$MODE" = "--debug" ]; then D8_MODE=--debug; else D8_MODE=--release; fi
"$BT/d8" "$D8_MODE" --min-api "$MIN_SDK" --lib "$ANDROID_JAR" --output "$BUILD/dex" "${CLASSES[@]}"

# Gate: framework APIs only, so every class in the dex is the app's own.
DEX_CLASSES="$("$BT/dexdump" "$BUILD/dex/classes.dex" | sed -n "s/^ *Class descriptor *: *'\(.*\)'$/\1/p")"
echo "$DEX_CLASSES" | grep -q '^Ldev/simmo/sonance/MainActivity;$' || fail "the dex lacks MainActivity."
FOREIGN="$(echo "$DEX_CLASSES" | grep -v '^Ldev/simmo/sonance/' || true)"
[ -z "$FOREIGN" ] || fail "the dex holds classes outside dev.simmo.sonance: $FOREIGN"
echo "  dex:     $(echo "$DEX_CLASSES" | wc -l | tr -d ' ') classes, all in dev.simmo.sonance"

( cd "$BUILD/dex" && zip -q -X ../unsigned.apk classes.dex )
"$BT/zipalign" -f -p 4 "$BUILD/unsigned.apk" "$BUILD/aligned.apk"

# ----- Sign -----------------------------------------------------------------

if [ "$MODE" = "--debug" ]; then
    OUT="$DEBUG_APK"
    KS="$BUILD/debug.keystore"
    if [ ! -f "$KS" ]; then
        echo "keytool: generating $KS (the standard debug key; not a secret)…"
        "$KEYTOOL" -genkeypair -keystore "$KS" -storepass android -keypass android \
            -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
            -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
    fi
    echo "apksigner: signing with the debug key…"
    "$BT/apksigner" sign --ks "$KS" --ks-key-alias androiddebugkey \
        --ks-pass pass:android --key-pass pass:android --out "$OUT" "$BUILD/aligned.apk"
else
    OUT="$RELEASE_APK"
    echo "apksigner: signing with your release key…"
    "$BT/apksigner" sign --ks "$SONANCE_KEYSTORE" --ks-key-alias "$SONANCE_KEY_ALIAS" \
        --ks-pass env:SONANCE_KEYSTORE_PASS --key-pass env:SONANCE_KEY_PASS \
        --out "$OUT" "$BUILD/aligned.apk"
fi
rm -f "$OUT.idsig"

# ----- Gates on the signed APK ----------------------------------------------

"$BT/apksigner" verify "$OUT" || fail "apksigner verify failed for $OUT."
echo "  apksigner verify: OK"

BADGING="$("$BT/aapt2" dump badging "$OUT")"
echo "$BADGING" | grep -q "^leanback-launchable-activity:" || fail "badging lacks LEANBACK_LAUNCHER."
echo "$BADGING" | grep -q "^application: .* banner='[^']" || fail "badging lacks the banner."
# D217: aapt2 prints minSdkVersion:'N' where aapt printed sdkVersion:'N'; either spelling passes.
echo "$BADGING" | grep -qxE "(min)?[sS]dkVersion:'$MIN_SDK'" || fail "badging lacks sdkVersion:'$MIN_SDK'."
echo "$BADGING" | grep -qx "targetSdkVersion:'$TARGET_SDK'" || fail "badging lacks targetSdkVersion:'$TARGET_SDK'."
if [ "$MODE" = "--release" ]; then
    echo "$BADGING" | grep -qx "application-debuggable" && fail "the release APK is debuggable."
else
    echo "$BADGING" | grep -qx "application-debuggable" || fail "the debug APK is not debuggable."
fi
echo "  badging: LEANBACK_LAUNCHER, banner, sdkVersion $MIN_SDK, targetSdkVersion $TARGET_SDK"

unzip -Z1 "$OUT" | grep -qxF "assets/$SHIM_REL" || fail "the APK lacks assets/$SHIM_REL."

echo ""
echo "Built: $OUT ($(du -h "$OUT" | cut -f1)), $VERSION_NAME ($VERSION_CODE)"
echo "Install: adb install -r \"$OUT\""
echo "============================================"
