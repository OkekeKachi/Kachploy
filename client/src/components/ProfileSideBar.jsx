import React from 'react';
import { Link } from 'react-router-dom';
import { User, Pencil, MapPin } from 'lucide-react';
import Card from './ui/Card';
import Badge from './ui/Badge';

/*
  STAGE 11.3: responsive profile summary.

  The prop contract is unchanged -- this still renders the `user` object that
  EmployeeDashboard already loads -- and so is the one real profile action: a link
  to /profile (the only target from the old sidebar that matched a route in
  App.jsx).

  Removed as confirmed demonstration content (not a layout simplification):
    - the `https://via.placeholder.com/80` avatar placeholder;
    - the `user.title || 'Full Stack Web Developer'` fallback -- `title` is not a
      field CompleteProfile ever writes (it writes fullName, phone, address,
      profilePic, skills, yearsOfExperience, availability / companyName, jobTypes,
      location), so that subtitle was always fabricated;
    - the hardcoded "100%" completion figure and full progress bar;
    - the "Promote with ads" rows, whose only targets were `href="#!"`;
    - the "Networks: 820" section, whose hardcoded count had no data source and
      whose links pointed at /buy-Networks, /view-details and /free-networks --
      none of which exist in App.jsx;
    - the Preferences / Proposals / Project Catalog / Get Paid / Help Center rows,
      which had no href and no handler at all.

  It now shows only real profile data (fullName, profilePic, role, location and
  the employee's skills) on a single shared Card, alongside the /profile action,
  and reads as a compact full-width summary below the job list on mobile.
*/
const ProfileSidebar = ({ user }) => {
    const skills = Array.isArray(user.skills) ? user.skills : [];

    return (
        <Card className="p-4 sm:p-5">
            <div className="flex items-center gap-4 sm:flex-col sm:text-center">
                {user.profilePic ? (
                    <img
                        src={user.profilePic}
                        alt=""
                        className="h-16 w-16 shrink-0 rounded-full object-cover"
                    />
                ) : (
                    <div
                        className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-surface-muted text-foreground-subtle"
                        aria-hidden="true"
                    >
                        <User className="h-8 w-8" />
                    </div>
                )}

                <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold text-foreground">
                        {user.fullName || 'Your profile'}
                    </h2>
                    {user.role && (
                        <p className="mt-0.5 text-sm capitalize text-foreground-muted">{user.role}</p>
                    )}
                    {user.location && (
                        <p className="mt-1 flex items-center gap-1 text-sm text-foreground-muted sm:justify-center">
                            <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span className="truncate">{user.location}</span>
                        </p>
                    )}
                </div>
            </div>

            {skills.length > 0 && (
                <div className="mt-5 border-t border-border pt-4">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-subtle">
                        Skills
                    </h3>
                    <div className="mt-2 flex flex-wrap gap-1.5 sm:justify-center">
                        {skills.map((skill, i) => (
                            <Badge key={i} variant="neutral">{skill}</Badge>
                        ))}
                    </div>
                </div>
            )}

            <Link
                to="/profile"
                className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-foreground transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
                <Pencil className="h-4 w-4" aria-hidden="true" />
                Edit profile
            </Link>
        </Card>
    );
};

export default ProfileSidebar;
