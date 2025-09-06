import React, { useEffect } from "react";
import { Link } from "react-router-dom"
import "@gl-admin/assets/styles/pages/not-found.scss";

const NotFound: React.FC = () => {
    useEffect(() => {
        document.title = "GoLive Admin | 404 Not Found";
    }, []);

    return (
        <div className="not-found">
            <h1 className="not-found__title">404</h1>
            <p className="not-found__message">Sorry, the page you are looking for does not exist.</p>
            <Link to="/" className="not-found__link">
                Go back to Dashboard
            </Link>
        </div>
    )
};

export default NotFound;