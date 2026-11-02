/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef6ff',
          100: '#d9ebff',
          500: '#0f63d8',
          600: '#0a4eb0',
          700: '#083a80'
        },
        accent: '#25bec9',
        success: '#19a876',
        warning: '#f5b546',
        danger: '#eb4d5c'
      },
      boxShadow: {
        soft: '0 15px 40px rgba(15, 99, 216, 0.14)'
      }
    }
  },
  plugins: []
};
