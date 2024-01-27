vim.opt.completeopt = {'menu', 'menuone', 'noselect'}

require('luasnip.loaders.from_vscode').lazy_load()

local cmp = require('cmp')
local luasnip = require('luasnip')

local select_opts = { behavior = cmp.SelectBehavior.Select }

local function border(hl_name)
  return {
    { '╭', hl_name },
    { '─', hl_name },
    { '╮', hl_name },
    { '│', hl_name },
    { '╯', hl_name },
    { '─', hl_name },
    { '╰', hl_name },
    { '│', hl_name },
  }
end

cmp.setup({
  snippet = {
    expand = function(args)
      luasnip.lsp_expand(args.body)
    end,
  },

  window = {
    completion = {
      side_padding = 0,
      winhighlight = 'Normal:CmpPmenu,CursorLine:CmpSel,Search:None',
      border = border('CmpBorder'),
    },
    documentation = {
      winhighlight = 'Normal:CmpPmenu,CursorLine:CmpSel,Search:None',
      border = border('CmpBorder'),
    },
  },

  sources = {
    { name = 'copilot', group_index = 2 },
    { name = 'nvim_lsp', keyword_length = 1, group_index = 2 },
    { name = 'path', group_index = 2 },
    { name = 'buffer', keyword_length = 3, group_index = 2 },
    { name = 'luasnip', keyword_length = 2, group_index = 2 },
  },

  formatting = {
    format = require('lspkind').cmp_format({
      mode = 'symbol_text', -- show only symbol annotations
      maxwidth = 50, -- prevent the popup from showing more than provided characters (e.g 50 will not show more than 50 characters)
      ellipsis_char = '...', -- when popup menu exceed maxwidth, the truncated part would show ellipsis_char instead (must define maxwidth first)
      show_labelDetails = true, -- show labelDetails in menu. Disabled by default
      symbol_map = {
        Copilot = "",
        Text = "󰉿",
        Method = "󰆧",
        Function = "󰊕",
        Constructor = "",
        Field = "󰜢",
        Variable = "󰀫",
        Class = "󰠱",
        Interface = "",
        Module = "",
        Property = "󰜢",
        Unit = "󰑭",
        Value = "󰎠",
        Enum = "",
        Keyword = "󰌋",
        Snippet = "",
        Color = "󰏘",
        File = "󰈙",
        Reference = "󰈇",
        Folder = "󰉋",
        EnumMember = "",
        Constant = "󰏿",
        Struct = "󰙅",
        Event = "",
        Operator = "󰆕",
        TypeParameter = "",
      }
    })
  },

  -- Sorting option coming from https://github.com/zbirenbaum/copilot-cmp#comparators
  sorting = {
    priority_weight = 2,
    comparators = {
      require("copilot_cmp.comparators").prioritize,

      -- Below is the default comparitor list and order for nvim-cmp
      cmp.config.compare.offset,
      -- cmp.config.compare.scopes, --this is commented in nvim-cmp too
      cmp.config.compare.exact,
      cmp.config.compare.score,
      cmp.config.compare.recently_used,
      cmp.config.compare.locality,
      cmp.config.compare.kind,
      cmp.config.compare.sort_text,
      cmp.config.compare.length,
      cmp.config.compare.order,
    },
  },

  mapping = {
    ['<Up>'] = cmp.mapping.select_prev_item(select_opts),
    ['<Down>'] = cmp.mapping.select_next_item(select_opts),
    ['<C-u>'] = cmp.mapping.scroll_docs(-1),
    ['<C-d>'] = cmp.mapping.scroll_docs(1),
    ['<CR>'] = cmp.mapping.confirm({ select = false }),
    ['<Tab>'] = cmp.mapping(function(fallback)
      if luasnip.jumpable(1) then
        luasnip.jump(1)
      else
        fallback()
      end
    end, {'i', 's'}),
    ['<S-Tab>'] = cmp.mapping(function(fallback)
      if luasnip.jumpable(-1) then
        luasnip.jump(-1)
      else
        fallback()
      end
    end, {'i', 's'}),
  },
})

-- Set configuration for specific filetype.
cmp.setup.filetype('gitcommit', {
  sources = cmp.config.sources(
    {
      { name = 'git' }, -- You can specify the `git` source if [you were installed it](https://github.com/petertriho/cmp-git).
    },
    {
      { name = 'buffer' },
    }
  )
})

-- Use buffer source for `/` and `?` (if you enabled `native_menu`, this won't work anymore).
cmp.setup.cmdline({ '/', '?' }, {
  mapping = cmp.mapping.preset.cmdline(),
  sources = {
    { name = 'buffer' }
  }
})

-- Use cmdline & path source for ':' (if you enabled `native_menu`, this won't work anymore).
cmp.setup.cmdline(':', {
  mapping = cmp.mapping.preset.cmdline(),
  sources = cmp.config.sources({
    { name = 'path' }
  }, {
      { name = 'cmdline' }
    })
})

-- Disable jumping after leaving insert mode.
vim.api.nvim_create_autocmd('InsertLeave', {
  callback = function()
    if
      require('luasnip').session.current_nodes[vim.api.nvim_get_current_buf()]
      and not require('luasnip').session.jump_active
    then
      require('luasnip').unlink_current()
    end
  end,
})

-----------------------------------------------------------
-- Adjust highlight colors based on everforst theme.
-----------------------------------------------------------
local configuration = vim.fn['everforest#get_configuration']()
local palette = vim.fn['everforest#get_palette'](configuration.background, configuration.colors_override)

-- Completion background color
vim.api.nvim_set_hl(0, 'CmpNormal', { bg = palette.bg0[1] })

-- Completion border
vim.api.nvim_set_hl(0, 'CmpBorder', { fg = palette.fg[1] })

-- Selected completion menu item
vim.api.nvim_set_hl(0, 'CmpSel', { bg = palette.aqua[1], fg = palette.bg0[1], bold = true })

-- Highlights text being typed, i.e. highlights 'im' in 'imports'
vim.api.nvim_set_hl(0, 'CmpItemAbbrMatch', { fg = palette.aqua[1], bold = true })
vim.api.nvim_set_hl(0, 'CmpItemAbbrMatchFuzzy', { fg = palette.aqua[1], bold = true })
