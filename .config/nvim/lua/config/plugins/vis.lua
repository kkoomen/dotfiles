-- Map ; to :B in combination with the vis.vim plugin
-- -----------------------------------------------------------------------------
-- The vis.vim plugin allows us to apply a command in visual-block mode only to
-- the selected block instead of the whole line. To do so, every command has to
-- be prefixed with 'B' which ends up in: '<, '>B [command].
-- -----------------------------------------------------------------------------
local opts = { noremap = true, silent = true, nowait = true }
vim.keymap.set('x', ';', ':B<space>', opts)
