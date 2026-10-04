#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -eq 0 ]]; then
  echo "Run this script as your normal Ubuntu WSL user, not root." >&2
  exit 2
fi

if ! grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease; then
  echo "This setup script must run inside WSL." >&2
  exit 2
fi

if ! grep -qi '^ID=ubuntu$' /etc/os-release; then
  echo "Ubuntu 20.04 or newer is required for this OpenLane setup." >&2
  exit 2
fi

source /etc/os-release
if [[ "$(printf '%s\n' "${VERSION_ID}" "20.04" | sort -V | head -n1)" != "20.04" ]]; then
  echo "Ubuntu 20.04 or newer is required; found ${VERSION_ID}." >&2
  exit 2
fi

command -v sudo >/dev/null || {
  echo "Install/configure sudo for your WSL user, then retry." >&2
  exit 2
}

sudo apt-get update
sudo apt-get install -y curl git iverilog xz-utils

nix_conf="$(printf '%s\n' \
  'extra-substituters = https://openlane.cachix.org' \
  'extra-trusted-public-keys = openlane.cachix.org-1:qqdwh+QMNGmZAuyeQJTH9ErW57OWSvdtuwfBKdS254E=')"

if ! command -v nix >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSfL https://install.determinate.systems/nix \
    | sh -s -- install --no-confirm --extra-conf "${nix_conf}"
fi

if [[ -f /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ]]; then
  # shellcheck disable=SC1091
  source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
fi

command -v nix >/dev/null 2>&1 || {
  echo "Nix is not available in this shell. Open a new WSL terminal and rerun this script." >&2
  exit 1
}

if [[ -f /etc/nix/nix.custom.conf ]] || grep -qF '!include nix.custom.conf' /etc/nix/nix.conf 2>/dev/null; then
  nix_config_path="/etc/nix/nix.custom.conf"
else
  nix_config_path="/etc/nix/nix.conf"
fi

if ! sudo grep -qF 'https://openlane.cachix.org' "${nix_config_path}" 2>/dev/null; then
  printf '%s\n' \
    'extra-substituters = https://openlane.cachix.org' \
    'extra-trusted-public-keys = openlane.cachix.org-1:qqdwh+QMNGmZAuyeQJTH9ErW57OWSvdtuwfBKdS254E=' \
    | sudo tee -a "${nix_config_path}" >/dev/null
  if command -v systemctl >/dev/null && sudo systemctl is-active --quiet nix-daemon; then
    sudo systemctl restart nix-daemon
  else
    sudo pkill -x nix-daemon 2>/dev/null || true
  fi
fi

openlane_dir="${AURA_OPENLANE_DIR:-${HOME}/.local/share/aura-silicon/openlane2}"
pdk_root="${AURA_PDK_ROOT:-${PDK_ROOT:-${HOME}/.volare}}"
mkdir -p "$(dirname "${openlane_dir}")" "${pdk_root}"

pdk_config_dir="${HOME}/.config/aura-silicon"
mkdir -p "${pdk_config_dir}"
temporary_pdk_config="${pdk_config_dir}/pdk-root.$$"
printf '%s\n' "${pdk_root}" > "${temporary_pdk_config}"
chmod 600 "${temporary_pdk_config}"
mv -f "${temporary_pdk_config}" "${pdk_config_dir}/pdk-root"

if [[ ! -e "${openlane_dir}" ]]; then
  git clone https://github.com/efabless/openlane2.git "${openlane_dir}"
elif [[ ! -f "${openlane_dir}/flake.nix" || ! -f "${openlane_dir}/openlane/open_pdks_rev" ]]; then
  echo "AURA_OPENLANE_DIR exists but is not a valid OpenLane 2 checkout: ${openlane_dir}" >&2
  exit 1
fi

pdk_revision="$(tr -d '[:space:]' < "${openlane_dir}/openlane/open_pdks_rev")"
if [[ ! "${pdk_revision}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "OpenLane's pinned open_pdks revision is invalid; refusing an unpinned PDK download." >&2
  exit 1
fi

(
  cd "${openlane_dir}"
  export PDK_ROOT="${pdk_root}"
  nix-shell --run "volare enable --pdk sky130 ${pdk_revision}"
  if [[ ! -d "${pdk_root}/sky130A" ]]; then
    echo "Volare did not enable the expected PDK directory: ${pdk_root}/sky130A" >&2
    exit 1
  fi
  nix-shell --run 'openlane --smoke-test'
)

echo
echo "OpenLane 2 and its pinned SKY130 PDK are installed."
echo "PDK_ROOT=${pdk_root}"
echo "To run an AURA OpenLane config:"
printf '  AURA_PDK_ROOT=%q bash %q %q\n' "${pdk_root}" \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run-openlane-wsl.sh" \
  "<design>/config.json"
