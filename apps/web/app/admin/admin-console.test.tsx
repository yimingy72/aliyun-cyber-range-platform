import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminConsole } from './admin-console';

describe('AdminConsole', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();

    vi.stubGlobal('fetch', vi.fn());
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        clear: () => {
          storage.clear();
        },
      },
    });
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the admin login form before authentication', () => {
    render(<AdminConsole apiBaseUrl="http://localhost:3001" />);

    expect(screen.getByRole('heading', { name: /admin control center/i }).textContent).toBe(
      'Admin Control Center'
    );
    expect(screen.getByLabelText(/username/i)).toBeTruthy();
    expect(screen.getByLabelText(/password/i)).toBeTruthy();
  });

  it('logs in and loads the resource sections', async () => {
    const fetchMock = vi.mocked(fetch);

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: 'dev-admin-token',
            profile: {
              username: 'admin',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'competition-1', name: 'Alibaba Cloud Finals 2026' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'team-1', name: 'Blue Team', competitionId: 'competition-1' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'template-1', slug: 'single-vpc-practice-range', version: 'v1' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    render(<AdminConsole apiBaseUrl="http://localhost:3001" />);

    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: 'admin' }
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'change-me' }
    });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/admin/session',
      expect.objectContaining({
        method: 'POST'
      })
    );

    await screen.findByText('Alibaba Cloud Finals 2026');
    expect(screen.getByText('Blue Team').textContent).toBe('Blue Team');
    expect(screen.getByText('single-vpc-practice-range').textContent).toBe('single-vpc-practice-range');
    expect(screen.getByText(/no range instances yet/i).textContent).toBe('No range instances yet.');

    await waitFor(() => {
      expect(window.localStorage.getItem('aliyun-cyber-range-admin-token')).toBe('dev-admin-token');
    });
  });

  it('updates and deletes admin resources after login', async () => {
    const fetchMock = vi.mocked(fetch);

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: 'dev-admin-token',
            profile: {
              username: 'admin',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 'competition-1',
              name: 'Alibaba Cloud Finals 2026',
              description: 'Finals event',
              status: 'scheduled',
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'team-1', name: 'Blue Team', competitionId: 'competition-1' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 'template-1',
              name: 'Single VPC Practice Range',
              slug: 'single-vpc-practice-range',
              version: 'v1',
              modulePathOrRef: 'infra/opentofu/modules/alicloud-vpc-single-ecs',
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'competition-1',
            name: 'Alibaba Cloud Finals Elite',
            description: 'Finals event',
            status: 'scheduled',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'template-1',
            name: 'Single VPC Practice Range',
            slug: 'single-vpc-practice-range',
            version: 'v1.1.0',
            modulePathOrRef: 'infra/opentofu/modules/alicloud-vpc-single-ecs',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    render(<AdminConsole apiBaseUrl="http://localhost:3001" />);

    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: 'admin' }
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'change-me' }
    });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await screen.findByText('Alibaba Cloud Finals 2026');

    fireEvent.click(screen.getByRole('button', { name: /edit competition alibaba cloud finals 2026/i }));
    fireEvent.change(screen.getByLabelText(/competition name/i), {
      target: { value: 'Alibaba Cloud Finals Elite' }
    });
    fireEvent.click(screen.getByRole('button', { name: /save competition/i }));

    await screen.findByText('Alibaba Cloud Finals Elite');

    fireEvent.click(screen.getByRole('button', { name: /delete team blue team/i }));

    await waitFor(() => {
      expect(screen.queryByText('Blue Team')).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /edit template single-vpc-practice-range/i }));
    fireEvent.change(screen.getByLabelText(/template version/i), {
      target: { value: 'v1.1.0' }
    });
    fireEvent.click(screen.getByRole('button', { name: /save template/i }));

    await screen.findByText('v1.1.0');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/admin/competitions/competition-1',
      expect.objectContaining({
        method: 'PATCH'
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/admin/teams/team-1',
      expect.objectContaining({
        method: 'DELETE'
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/admin/range-templates/template-1',
      expect.objectContaining({
        method: 'PATCH'
      })
    );
  });

  it('triggers range actions and loads provision jobs in the task center', async () => {
    const fetchMock = vi.mocked(fetch);

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: 'dev-admin-token',
            profile: {
              username: 'admin',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'competition-1', name: 'Alibaba Cloud Finals 2026' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: 'team-1', name: 'Blue Team', competitionId: 'competition-1' },
            { id: 'team-2', name: 'Red Team', competitionId: 'competition-1' },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'template-1', slug: 'enterprise-practice-range', version: 'v1' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 'range-1',
              teamId: 'team-1',
              status: 'create_failed',
              allocatedCidr: '10.70.0.0/16',
              lastJobId: 'job-1',
              errorSummary: 'OpenTofu plan failed in fake provisioner',
            },
            {
              id: 'range-2',
              teamId: 'team-2',
              status: 'running',
              allocatedCidr: '10.80.0.0/16',
              lastJobId: 'job-2',
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 'job-2',
              rangeInstanceId: 'range-2',
              jobType: 'create',
              status: 'succeeded',
              triggeredBy: 'admin',
            },
            {
              id: 'job-1',
              rangeInstanceId: 'range-1',
              jobType: 'create',
              status: 'failed',
              triggeredBy: 'admin',
              errorSummary: 'OpenTofu plan failed in fake provisioner',
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'job-3',
            rangeInstanceId: 'range-1',
            jobType: 'create',
            status: 'pending',
            triggeredBy: 'admin',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'competition-1', name: 'Alibaba Cloud Finals 2026' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: 'team-1', name: 'Blue Team', competitionId: 'competition-1' },
            { id: 'team-2', name: 'Red Team', competitionId: 'competition-1' },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'template-1', slug: 'enterprise-practice-range', version: 'v1' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 'range-1',
              teamId: 'team-1',
              status: 'pending_create',
              allocatedCidr: '10.70.0.0/16',
              lastJobId: 'job-3',
            },
            {
              id: 'range-2',
              teamId: 'team-2',
              status: 'running',
              allocatedCidr: '10.80.0.0/16',
              lastJobId: 'job-2',
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 'job-3',
              rangeInstanceId: 'range-1',
              jobType: 'create',
              status: 'pending',
              triggeredBy: 'admin',
            },
            {
              id: 'job-2',
              rangeInstanceId: 'range-2',
              jobType: 'create',
              status: 'succeeded',
              triggeredBy: 'admin',
            },
            {
              id: 'job-1',
              rangeInstanceId: 'range-1',
              jobType: 'create',
              status: 'failed',
              triggeredBy: 'admin',
              errorSummary: 'OpenTofu plan failed in fake provisioner',
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'job-3',
            rangeInstanceId: 'range-1',
            jobType: 'create',
            status: 'pending',
            triggeredBy: 'admin',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

    render(<AdminConsole apiBaseUrl="http://localhost:3001" />);

    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: 'admin' }
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'change-me' }
    });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await screen.findByRole('button', { name: /create range range-1/i });

    expect(screen.getByRole('button', { name: /create range range-1/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /destroy range range-2/i })).toBeTruthy();

    const jobsHeading = await screen.findByRole('heading', { name: /provision jobs/i });
    const jobsPanel = jobsHeading.closest('section');

    expect(jobsPanel).toBeTruthy();
    expect(within(jobsPanel as HTMLElement).getByText('job-2').textContent).toBe('job-2');

    fireEvent.click(screen.getByRole('button', { name: /create range range-1/i }));

    await waitFor(() => {
      const rangeRow = screen.getByRole('button', { name: /view details for range instance range-1/i }).closest('li');

      expect(rangeRow).toBeTruthy();
      expect(within(rangeRow as HTMLElement).getByText('pending_create').textContent).toBe('pending_create');
    });

    expect(within(jobsPanel as HTMLElement).getByText('job-3').textContent).toBe('job-3');

    fireEvent.click(screen.getByRole('button', { name: /view provision job job-3/i }));

    await screen.findByRole('heading', { name: /provision job detail/i });
    expect(screen.getAllByText('pending').length).toBeGreaterThan(0);
    expect(screen.getByText(/no step logs recorded yet/i).textContent).toBe('No step logs recorded yet.');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/admin/range-instances/range-1/create',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer dev-admin-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          triggeredBy: 'admin',
        }),
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/admin/provision-jobs',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer dev-admin-token',
        }),
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/admin/provision-jobs/job-3/steps',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer dev-admin-token',
        }),
      })
    );
  });

  it('loads range instance detail, last job summary, and step logs on demand', async () => {
    const fetchMock = vi.mocked(fetch);

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: 'dev-admin-token',
            profile: {
              username: 'admin',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'competition-1', name: 'Alibaba Cloud Finals 2026' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'team-1', name: 'Blue Team', competitionId: 'competition-1' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'template-1', slug: 'enterprise-practice-range', version: 'v1' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 'range-1',
              teamId: 'team-1',
              status: 'create_failed',
              allocatedCidr: '10.70.0.0/16',
              lastJobId: 'job-1',
              errorSummary: 'OpenTofu plan failed in fake provisioner',
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 'job-1',
              rangeInstanceId: 'range-1',
              jobType: 'create',
              status: 'failed',
              triggeredBy: 'admin',
              errorSummary: 'OpenTofu plan failed in fake provisioner',
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'range-1',
            competitionId: 'competition-1',
            teamId: 'team-1',
            templateId: 'template-1',
            status: 'create_failed',
            allocatedCidr: '10.70.0.0/16',
            lastJobId: 'job-1',
            errorSummary: 'OpenTofu plan failed in fake provisioner',
            accessEntry: {
              hostRole: 'dmz',
              publicIp: '47.0.0.10',
              ssh: 'ssh root@47.0.0.10',
            },
            resourceSummary: {
              mode: 'opentofu',
              vpcId: 'vpc-123',
              topologySpec: {
                vpcCidr: '10.70.0.0/16',
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'job-1',
            rangeInstanceId: 'range-1',
            jobType: 'create',
            status: 'failed',
            triggeredBy: 'admin',
            errorSummary: 'OpenTofu plan failed in fake provisioner',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 'step-1',
              jobId: 'job-1',
              stepName: 'prepare',
              status: 'succeeded',
            },
            {
              id: 'step-2',
              jobId: 'job-1',
              stepName: 'tofu_plan',
              status: 'failed',
              message: 'Fake plan failed.',
              stderrExcerpt: 'simulated stderr from fake plan',
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    render(<AdminConsole apiBaseUrl="http://localhost:3001" />);

    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: 'admin' }
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'change-me' }
    });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await screen.findByRole('button', { name: /view details for range instance range-1/i });

    fireEvent.click(screen.getByRole('button', { name: /view details for range instance range-1/i }));

    const detailHeading = await screen.findByRole('heading', { name: /range instance detail/i });
    const detailPanel = detailHeading.closest('section');

    expect(detailPanel).toBeTruthy();
    expect(
      within(detailPanel as HTMLElement).getAllByText('OpenTofu plan failed in fake provisioner').length
    ).toBeGreaterThan(0);
    expect(screen.getByText('ssh root@47.0.0.10').textContent).toBe('ssh root@47.0.0.10');
    expect(within(detailPanel as HTMLElement).getByText('tofu_plan').textContent).toBe('tofu_plan');
    expect(within(detailPanel as HTMLElement).getByText('simulated stderr from fake plan').textContent).toBe(
      'simulated stderr from fake plan'
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/admin/range-instances/range-1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer dev-admin-token',
        }),
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/admin/provision-jobs/job-1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer dev-admin-token',
        }),
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/admin/provision-jobs/job-1/steps',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer dev-admin-token',
        }),
      })
    );
  });
});
