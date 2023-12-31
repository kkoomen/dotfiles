-- Imported files are located in ~/.config/nvim/lua/
-- Plugins are installed at ~/.local/share/nvim/site/pack/packer/start/
require('plugins')
require('config.global')
require('config.autocmd')
require('config.mappings')
require('config.hooks')
require('config.commands')
-- TODO: show git buffer commits
-- TODO: add custom snippets
-- TODO: pressing <CR> auto-complete with filepath OR one suggetion not confirming
