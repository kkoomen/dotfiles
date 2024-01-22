local function statusline_indent()
  return (vim.bo.expandtab and 'spaces' or 'tabs') .. ':' .. vim.bo.shiftwidth
end

local function statusline_readonly()
  return vim.bo.readonly and '' or ''
end

local function statusline_filename()
  local path = vim.fn.expand('%:p')
  if path == '' then
    return '[No Name]'
  end

  -- The path should be at most some percent of the total width
  local max_percent_width = 0.3
  local win_width = vim.fn.winwidth(vim.fn.winnr())
  local max_width = win_width * max_percent_width

  -- If the current width exceeds the maximum we occupy, only show the first
  -- character of the highest parent directory
  local index = 1
  local path_splitted = vim.fn.split(path, '/')
  local new_path = path
  while #new_path >= max_width and index < #path_splitted do
    path_splitted[index] = path_splitted[index]:sub(1, 1)
    index = index + 1
    new_path = '/' .. table.concat(path_splitted, '/')
  end

  -- Check if the name is still too long, if so, truncate as well
  if #new_path > max_width then
    -- Only show <parent-folder>/<file>.<ext>
    new_path = vim.fn.expand('%:p:h:t') .. '/' .. vim.fn.expand('%:t')

    if #new_path > max_width then
      -- Only show <file>.<ext>
      new_path = vim.fn.expand('%:t')
    end
  end

  return new_path
end

local function statusline_wordcount()
  -- Check if the file type is in the specified list
  local allowed_filetypes = {'', 'text', 'markdown', 'tex', 'asciidoc', 'help', 'mail', 'org', 'rst'}
  local ft_index = vim.fn.index(allowed_filetypes, vim.bo.ft)
  if ft_index < 0 then
    return ''
  end

  -- Calculate word count
  local word_count
  if vim.fn.has_key(vim.fn.wordcount(), 'visual_words') == 1 then
    word_count = vim.fn.wordcount().visual_words .. '/' .. vim.fn.wordcount().words
  else
    word_count = vim.fn.wordcount().cursor_words .. '/' .. vim.fn.wordcount().words
  end

  -- Calculate character count
  local char_count = math.max(0, vim.fn.wordcount().chars - 1)

  return 'words:' .. word_count .. ', chars:' .. char_count
end

local function statusline_gutentags_status()
  if vim.fn.exists('*gutentags#statusline') == 1 then
      vim.api.nvim_exec([[
          return gutentags#statusline('', ':running')
      ]], false)
  end
end

require('lualine').setup {
  options = {
    icons_enabled = true
  },
  tabline = {
    lualine_a = {
      {
        'buffers',
        symbols = {
          modified = ' [+]',
          alternate_file = '',
        },
      }
    },
  },
  sections = {
    lualine_c = {
      statusline_readonly,
      statusline_filename,
    },
    lualine_x = {
      statusline_gutentags_status,
      statusline_wordcount,
      statusline_indent,
      'encoding',
      'fileformat',
      'filetype',
    },
    lualine_y = {
      {
        'progress',
        fmt = function(str)
          if str == 'Bot' then
            return '100%%'
          end

          return str
        end
      }
    },
  }
}
