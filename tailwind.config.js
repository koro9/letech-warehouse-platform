/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js}'],
  theme: {
    extend: {
      colors: {
        // demo 配色（来自 一體化demo_放vs code .html）
        teal: { DEFAULT: '#6BAB9E' },
        pink: { DEFAULT: '#D4918E' },
        sage: { DEFAULT: '#4A90D9' },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI',
               'Microsoft JhengHei', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
