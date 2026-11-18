#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_DIR="${REPO_ROOT}/src"
UUID="rivalcfg-control@yusufkaya00.github.io"
LEGACY_UUID="aerox3-control@ysf.local"
EXT_BASE="${HOME}/.local/share/gnome-shell/extensions"
DEST_DIR="${EXT_BASE}/${UUID}"
LEGACY_DEST_DIR="${EXT_BASE}/${LEGACY_UUID}"

if [[ ! -f "${SRC_DIR}/metadata.json" ]]; then
    echo "Error: ${SRC_DIR}/metadata.json not found" >&2
    exit 1
fi

mkdir -p "${EXT_BASE}"

if [[ -d "${LEGACY_DEST_DIR}" ]]; then
    rm -rf "${LEGACY_DEST_DIR}"
    echo "Removed legacy extension directory: ${LEGACY_DEST_DIR}"
fi

rm -rf "${DEST_DIR}"
mkdir -p "${DEST_DIR}"
cp -a "${SRC_DIR}/." "${DEST_DIR}/"
find "${DEST_DIR}" -name '__pycache__' -type d -exec rm -rf {} +

chmod +x "${DEST_DIR}/helpers/color_picker.py"

if command -v gsettings >/dev/null 2>&1; then
    CURRENT_EXTS="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo "@as []")"
    UPDATED_EXTS="$(python3 - "${CURRENT_EXTS}" "${UUID}" "${LEGACY_UUID}" <<'PY'
import ast
import sys

raw = sys.argv[1].strip()
uuid = sys.argv[2]
legacy_uuid = sys.argv[3]

if raw in ("", "@as []"):
    exts = []
else:
    if raw.startswith("@as "):
        raw = raw[4:].strip()
    exts = list(ast.literal_eval(raw))

original = list(exts)
exts = [item for item in exts if item != legacy_uuid]

if uuid not in exts:
    exts.append(uuid)

changed = exts != original
formatted = "[" + ", ".join(repr(item) for item in exts) + "]"
print(("CHANGED:" if changed else "UNCHANGED:") + formatted)
PY
)"
    if [[ "${UPDATED_EXTS}" == CHANGED:* ]]; then
        NEW_VAL="${UPDATED_EXTS#CHANGED:}"
        gsettings set org.gnome.shell enabled-extensions "${NEW_VAL}"
        echo "Updated org.gnome.shell enabled-extensions: ${NEW_VAL}"
    else
        CUR_VAL="${UPDATED_EXTS#UNCHANGED:}"
        echo "'${UUID}' already enabled in org.gnome.shell enabled-extensions: ${CUR_VAL}"
    fi
else
    echo "Warning: gsettings not found; skipping enabled-extensions update." >&2
fi

echo "Installed ${UUID} to ${DEST_DIR}"
if [[ "${XDG_SESSION_TYPE:-}" == "x11" ]]; then
    echo "Note: On X11, press Alt+F2, type 'r', and press Enter to reload GNOME Shell and discover the extension."
else
    echo "Note: Log out and log back in (Wayland) or press Alt+F2 -> r -> Enter (X11) to reload GNOME Shell."
fi
