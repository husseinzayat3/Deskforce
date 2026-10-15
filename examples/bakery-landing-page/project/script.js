document.addEventListener('DOMContentLoaded', function() {
    const form = document.querySelector('form');
    const nameInput = form.querySelector('input[name="name"]');
    const emailInput = form.querySelector('input[name="email"]');
    const messageTextarea = form.querySelector('textarea[name="message"]');

    form.addEventListener('submit', function(event) {
        event.preventDefault(); // Prevent form submission

        const name = nameInput.value.trim();
        const email = emailInput.value.trim();
        const message = messageTextarea.value.trim();
        
        let formValid = true;

        // Basic name validation
        if (name === '') {
            alert('Please enter your name.');
            formValid = false;
        }

        // Basic email validation
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailPattern.test(email)) {
            alert('Please enter a valid email address.');
            formValid = false;
        }

        // Basic message validation
        if (message === '') {
            alert('Please enter your message.');
            formValid = false;
        }

        // Submit form if validation passes
        if (formValid) {
            form.submit();
        }
    });
});
