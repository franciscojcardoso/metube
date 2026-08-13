#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
desktop_dir=$(xdg-user-dir DESKTOP 2>/dev/null || true)
[ -n "$desktop_dir" ] || desktop_dir="$HOME/Desktop"

for command_name in curl docker ffmpeg xdg-open systemctl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Dependência ausente: $command_name" >&2
    exit 1
  fi
done

if ! command -v uv >/dev/null 2>&1; then
  echo "Instalando o gerenciador Python uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "O pnpm não foi encontrado. Instale Node.js e execute: corepack enable" >&2
  exit 1
fi

echo "Instalando dependências e compilando a interface..."
cd "$project_dir/ui"
pnpm install --frozen-lockfile
pnpm run build

cd "$project_dir"
uv sync --frozen
chmod +x scripts/metube-service scripts/metube-launch

echo "Baixando o servidor de transcrição local..."
docker pull hwdsl2/whisper-server

mkdir -p "$config_home/systemd/user" "$data_home/applications" "$desktop_dir" "$HOME/Downloads/MeTube"
escaped_project_dir=$(printf '%s' "$project_dir" | sed 's/[&|]/\\&/g')
sed "s|@PROJECT_DIR@|$escaped_project_dir|g" packaging/metube.service.in > "$config_home/systemd/user/metube.service"
sed "s|@PROJECT_DIR@|$escaped_project_dir|g" packaging/metube-whisper.service.in > "$config_home/systemd/user/metube-whisper.service"
sed "s|@PROJECT_DIR@|$escaped_project_dir|g" packaging/metube.desktop.in > "$data_home/applications/metube.desktop"
chmod +x "$data_home/applications/metube.desktop"
cp "$data_home/applications/metube.desktop" "$desktop_dir/MeTube.desktop"
chmod +x "$desktop_dir/MeTube.desktop"
command -v gio >/dev/null 2>&1 && gio set "$desktop_dir/MeTube.desktop" metadata::trusted true 2>/dev/null || true

systemctl --user daemon-reload
systemctl --user enable metube-whisper.service metube.service
systemctl --user restart metube-whisper.service metube.service
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$data_home/applications" || true

echo "MeTube instalado no menu do Linux Mint e na Área de Trabalho."
echo "Downloads serão salvos inicialmente em: $HOME/Downloads/MeTube"
echo "O modelo small, otimizado para esta CPU, será preparado em segundo plano na primeira inicialização."
