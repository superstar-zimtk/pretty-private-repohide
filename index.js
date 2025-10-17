     pretty-repo protected by XHYPHER team

        clearSessionFiles(); // Use the helper function
        
        // Force an exit to restart the entire login flow cleanly
        process.exit(1);
    }
    
    // 9. Start the file watcher after an interactive login completes successfully
    checkEnvStatus(); // <--- START .env FILE WATCHER (Mandatory)
}

// --- Start bot (PRETTY MD) ---
tylor().catch(err => log(`Fatal error starting bot: ${err.message}`, 'red', true));
process.on('uncaughtException', (err) => log(`Uncaught Exception: ${err.message}`, 'red', true));
process.on('unhandledRejection', (err) => log(`Unhandled Rejection: ${err.message}`, 'red', true));
