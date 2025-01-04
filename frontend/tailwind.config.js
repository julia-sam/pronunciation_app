/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ['./src/**/*.{js,jsx,ts,tsx}'],
    theme: {
        extend: {
            colors: {
                textBlack: '#000000',
                textWhite: '#FFFFFF',
                brightYellow: '#FFD700',
                lightGray: '#F4F4F4',
                darkGray: '#A9A9A9',
                turquoise: '#8DC6BF'
            },
        },
    },
    plugins: [],
};