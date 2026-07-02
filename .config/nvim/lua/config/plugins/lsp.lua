local capabilities = require('cmp_nvim_lsp').default_capabilities()

local servers = {
  lua_ls = {                  -- Lua
    settings = {
      Lua = {
        diagnostics = {
          globals = { 'vim' },
        },
      },
    },
  },

  basedpyright = {},          -- Python
  ts_ls = {},                 -- TypeScript
  vuels = {},                 -- Vue.js
  html = {},                  -- HTML
  cssls = {},                 -- CSS
  bashls = {},                -- Bash/shell
  jsonls = {},                -- JSON
  yamlls = {},                -- YAML
  vimls = {},                 -- Vimscript
  ruby_lsp = {},              -- Ruby
  clangd = {},                -- C/C++
  jdtls = {},                 -- Java
  rust_analyzer = {},         -- Rust
  texlab = {},                -- LaTeX
}

require('mason').setup()
require('mason-lspconfig').setup({
  ensure_installed = vim.tbl_keys(servers),
})

for name, config in pairs(servers) do
  config.capabilities = capabilities
  vim.lsp.config(name, config)
end

vim.lsp.enable(vim.tbl_keys(servers))

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
