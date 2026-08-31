export interface SidebarProject {
  id: string;
  name: string;
}

export function visibleSidebarProjects(projects: SidebarProject[], projectLibraryOpen: boolean): SidebarProject[] {
  return projectLibraryOpen ? projects : projects.slice(0, 6);
}

export function sidebarHasProjectOverflow(projects: SidebarProject[], visible: SidebarProject[]): boolean {
  return projects.length > visible.length;
}
