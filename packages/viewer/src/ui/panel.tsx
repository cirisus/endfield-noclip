import { createContext, useContext, type ComponentType, type ReactNode } from 'react';

/** Named slots let a host style panel chrome without replacing the scene controls. */
export interface PanelProps {
	title: string;
	label: string;
	className?: string;
	actions?: ReactNode;
	children: ReactNode;
}

const DefaultPanel = ({ title, label, className = '', actions, children }: PanelProps) => (
	<section className={`panel ${className}`} aria-label={label}>
		<header>
			<h2>{title}</h2>
			{actions}
		</header>
		<div className="panel-body">{children}</div>
	</section>
);
const Context = createContext<ComponentType<PanelProps>>(DefaultPanel);

/** @param props host panel component and viewer subtree @returns panels using the host's presentation */
export const PanelProvider = ({
	component,
	children,
}: {
	component: ComponentType<PanelProps>;
	children: ReactNode;
}) => <Context value={component}>{children}</Context>;

/** @param props panel title, actions and body @returns the configured panel shell */
export const Panel = (props: PanelProps) => {
	const Component = useContext(Context);
	return <Component {...props} />;
};
