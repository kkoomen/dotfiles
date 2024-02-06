local lspconfig = require('lspconfig')

local servers = {
  {                           -- Lua
    name = 'lua_ls',
    settings = {
      Lua = {
        diagnostics = {
          -- Get the language server to recognize the `vim` global
          globals = {'vim'},
        },
      },
    },
  },
  { name = 'tsserver' },      -- TypeScript
  { name = 'html' },          -- HTML
  { name = 'cssls' },         -- CSS
  {                           -- Python
    name = 'pylsp',
    settings = {
      pylsp = {
        plugins = {
          flake8 = {enabled = true},
          pycodestyle = {enabled = false},
          pyflakes = {enabled = false},
          pylint = {enabled = false},
          mccabe = {enabled = false},
        },
      },
    },
  },
  { name = 'bashls' },        -- Bash/shell
  { name = 'intelephense' },  -- PHP
  { name = 'yamlls' },        -- YAML
  { name = 'jsonls' },        -- JSON
  { name = 'vimls' },         -- Vimscript
  { name = 'ruby_ls' },       -- Ruby
  { name = 'vls' },           -- Vue
  { name = 'clangd' },        -- C/C++
  { name = 'jdtls' },         -- Java
  { name = 'rust_analyzer' }, -- Rust
  { name = 'texlab' },        -- LaTeX
}

-- Get all the server names.
local server_names = {}
for _, server_info in ipairs(servers) do
  table.insert(server_names, server_info.name)
end

require('mason').setup()
require('mason-lspconfig').setup({
  ensure_installed = server_names,
  automatic_installation = true,
})

-- Register all the servers.
local capabilities = require('cmp_nvim_lsp').default_capabilities()
for _, server_info in ipairs(servers) do
  local server = server_info.name
  local settings = server_info.settings

  local setup_config = { capabilities = capabilities }
  if settings then
    setup_config.settings = settings
  end

  lspconfig[server].setup(setup_config)
end

local function goto_definition()
  -- Let LSP go to the definition, otherwise fallback on tags.
  local status, result = pcall(vim.lsp.buf.definition)
  if not status then
    vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<C-]>', true, false, true), 'n', true)
  end
end

-- Use LspAttach autocommand to only map the following keys
-- after the language server attaches to the current buffer
-- See https://github.com/neovim/nvim-lspconfig
vim.api.nvim_create_autocmd('LspAttach', {
  group = vim.api.nvim_create_augroup('UserLspConfig', {}),
  callback = function(ev)
    -- Allow vim native usage of 'gw' and 'gq'
    vim.bo[ev.buf].formatexpr = nil

    -- Buffer local mappings.
    -- See `:help vim.lsp.*` for documentation on any of the below functions
    local opts = { buffer = ev.buf }
    vim.keymap.set('n', 'K', vim.lsp.buf.hover, opts)
    vim.keymap.set('n', 'gD', vim.lsp.buf.declaration, opts)
    vim.keymap.set('n', 'gd', goto_definition, opts)
    vim.keymap.set('n', 'gi', vim.lsp.buf.implementation, opts)
    vim.keymap.set('n', 'gt', vim.lsp.buf.type_definition, opts)
    vim.keymap.set('n', 'gr', vim.lsp.buf.references, opts)
    vim.keymap.set('n', '<space>rn', vim.lsp.buf.rename, opts)
    vim.keymap.set('n', '<space>f', function()
      vim.lsp.buf.format { async = true }
    end, opts)
  end,
})

-- Adjust diagnostic signs.
local signs = { Error = '󰅙', Warn = '󰀦', Hint = "󰐗", Info = "󰋼" }
for type, icon in pairs(signs) do
  local hl = 'DiagnosticSign' .. type
  vim.fn.sign_define(hl, { text = icon, texthl = hl, numhl = hl })
end
