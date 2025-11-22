import { DataCache } from '../src/database/cache';
import { MachineStateDocument, MachineStatus } from '../src/database/schema';
import { MachineStateTable } from '../src/database/table';
import { IdentityProviderClient } from '../src/external/idp';
import { SmartMachineClient } from '../src/external/smart-machine';
import { ApiHandler } from '../src/handler/api';
import { HttpMethod, HttpResponseCode, RequestMachineRequestModel } from '../src/handler/model';

// Mock the dependencies
jest.mock('../src/database/table');
jest.mock('../src/external/idp');
jest.mock('../src/external/smart-machine');
jest.mock('../src/database/cache');

describe('ApiHandler', () => {
  let apiHandler: ApiHandler;
  let mockMachineStateTable: jest.Mocked<MachineStateTable>;
  let mockIdpClient: jest.Mocked<IdentityProviderClient>;
  let mockSmartMachineClient: jest.Mocked<SmartMachineClient>;
  let mockCache: jest.Mocked<DataCache<MachineStateDocument>>;

  const VALID_TOKEN = 'valid-token';
  const INVALID_TOKEN = 'invalid-token';

  beforeEach(() => {
    // Reset mocks before each test
    jest.clearAllMocks();

    // Setup mock implementations
    mockMachineStateTable = new (MachineStateTable as any)() as jest.Mocked<MachineStateTable>;
    jest.spyOn(MachineStateTable, 'getInstance').mockReturnValue(mockMachineStateTable);

    mockIdpClient = new (IdentityProviderClient as any)() as jest.Mocked<IdentityProviderClient>;
    jest.spyOn(IdentityProviderClient, 'getInstance').mockReturnValue(mockIdpClient);

    mockSmartMachineClient = new (SmartMachineClient as any)() as jest.Mocked<SmartMachineClient>;
    jest.spyOn(SmartMachineClient, 'getInstance').mockReturnValue(mockSmartMachineClient);

    mockCache = new (DataCache as any)() as jest.Mocked<DataCache<MachineStateDocument>>;
    jest.spyOn(DataCache, 'getInstance').mockReturnValue(mockCache);

    apiHandler = new ApiHandler();

    // Default mock behaviors
    mockIdpClient.validateToken.mockImplementation((token: string) => token === VALID_TOKEN);
  });

  describe('Authentication', () => {
    it('should throw an error for an invalid token', () => {
      const request = {
        method: HttpMethod.POST,
        path: '/machine/request',
        token: INVALID_TOKEN,
      };
      expect(() => apiHandler.handle(request)).toThrow(
        JSON.stringify({
          statusCode: HttpResponseCode.UNAUTHORIZED,
          message: 'Invalid token',
        })
      );
    });
  });

  describe('handleRequestMachine', () => {
    const locationId = 'location-a';
    const jobId = 'job-123';

    it('should reserve an available machine', () => {
      const availableMachine: MachineStateDocument = {
        machineId: 'machine-1',
        locationId,
        status: MachineStatus.AVAILABLE,
        currentJobId: null,
      };
      const updatedMachine: MachineStateDocument = {
        ...availableMachine,
        status: MachineStatus.AWAITING_DROPOFF,
        currentJobId: jobId,
      };

      mockMachineStateTable.listMachinesAtLocation.mockReturnValue([availableMachine]);
      mockMachineStateTable.getMachine.mockReturnValue(updatedMachine);

      const request: RequestMachineRequestModel = {
        method: HttpMethod.POST,
        path: '/machine/request',
        token: VALID_TOKEN,
        locationId,
        jobId,
      };
      const response = apiHandler.handle(request);

      expect(response.statusCode).toBe(HttpResponseCode.OK);
      expect(response.machine).toEqual(updatedMachine);
      expect(mockMachineStateTable.updateMachineStatus).toHaveBeenCalledWith(availableMachine.machineId, MachineStatus.AWAITING_DROPOFF);
      expect(mockMachineStateTable.updateMachineJobId).toHaveBeenCalledWith(availableMachine.machineId, jobId);
      expect(mockCache.put).toHaveBeenCalledWith(updatedMachine.machineId, updatedMachine);
    });

    it('should return NOT_FOUND if no machines are available', () => {
        mockMachineStateTable.listMachinesAtLocation.mockReturnValue([]);
        const request: RequestMachineRequestModel = {
            method: HttpMethod.POST,
            path: '/machine/request',
            token: VALID_TOKEN,
            locationId,
            jobId,
        };
        const response = apiHandler.handle(request);
        expect(response.statusCode).toBe(HttpResponseCode.NOT_FOUND);
    });
  });

  describe('handleGetMachine', () => {
    const machineId = 'machine-1';
    const machine: MachineStateDocument = { machineId, locationId: 'location-a', status: MachineStatus.RUNNING, currentJobId: 'job-1' };

    it('should return a machine from the cache', () => {
        mockCache.get.mockReturnValue(machine);
        const response = apiHandler.handle({ method: HttpMethod.GET, path: `/machine/${machineId}`, token: VALID_TOKEN });

        expect(response.statusCode).toBe(HttpResponseCode.OK);
        expect(response.machine).toEqual(machine);
        expect(mockMachineStateTable.getMachine).not.toHaveBeenCalled();
    });

    it('should return a machine from the database if not in cache', () => {
        mockCache.get.mockReturnValue(undefined);
        mockMachineStateTable.getMachine.mockReturnValue(machine);
        const response = apiHandler.handle({ method: HttpMethod.GET, path: `/machine/${machineId}`, token: VALID_TOKEN });

        expect(response.statusCode).toBe(HttpResponseCode.OK);
        expect(response.machine).toEqual(machine);
        expect(mockCache.put).toHaveBeenCalledWith(machineId, machine);
    });

    it('should return NOT_FOUND if machine does not exist', () => {
        mockCache.get.mockReturnValue(undefined);
        mockMachineStateTable.getMachine.mockReturnValue(undefined);
        const response = apiHandler.handle({ method: HttpMethod.GET, path: `/machine/${machineId}`, token: VALID_TOKEN });
        expect(response.statusCode).toBe(HttpResponseCode.NOT_FOUND);
    });
  });

  describe('handleStartMachine', () => {
    const machineId = 'machine-1';
    const machine: MachineStateDocument = { machineId, locationId: 'location-a', status: MachineStatus.AWAITING_DROPOFF, currentJobId: 'job-1' };

    it('should start a machine that is awaiting dropoff', () => {
        const updatedMachine = { ...machine, status: MachineStatus.RUNNING };
        mockMachineStateTable.getMachine.mockReturnValueOnce(machine).mockReturnValueOnce(updatedMachine);

        const response = apiHandler.handle({ method: HttpMethod.POST, path: `/machine/${machineId}/start`, token: VALID_TOKEN });

        expect(response.statusCode).toBe(HttpResponseCode.OK);
        expect(response.machine).toEqual(updatedMachine);
        expect(mockSmartMachineClient.startCycle).toHaveBeenCalledWith(machineId);
        expect(mockMachineStateTable.updateMachineStatus).toHaveBeenCalledWith(machineId, MachineStatus.RUNNING);
        expect(mockCache.put).toHaveBeenCalledWith(machineId, updatedMachine);
    });

    it('should return BAD_REQUEST if machine is not awaiting dropoff', () => {
        const runningMachine = { ...machine, status: MachineStatus.RUNNING };
        mockMachineStateTable.getMachine.mockReturnValue(runningMachine);

        const response = apiHandler.handle({ method: HttpMethod.POST, path: `/machine/${machineId}/start`, token: VALID_TOKEN });

        expect(response.statusCode).toBe(HttpResponseCode.BAD_REQUEST);
        expect(response.machine).toEqual(runningMachine);
    });

    it('should handle hardware errors when starting a machine', () => {
        const errorMachine = { ...machine, status: MachineStatus.ERROR };
        mockMachineStateTable.getMachine.mockReturnValueOnce(machine).mockReturnValueOnce(errorMachine);
        mockSmartMachineClient.startCycle.mockImplementation(() => {
            throw new Error('Hardware fault');
        });

        const response = apiHandler.handle({ method: HttpMethod.POST, path: `/machine/${machineId}/start`, token: VALID_TOKEN });

        expect(response.statusCode).toBe(HttpResponseCode.HARDWARE_ERROR);
        expect(response.machine).toEqual(errorMachine);
        expect(mockMachineStateTable.updateMachineStatus).toHaveBeenCalledWith(machineId, MachineStatus.ERROR);
        expect(mockCache.put).toHaveBeenCalledWith(machineId, errorMachine);
    });

    it('should return NOT_FOUND if machine to start does not exist', () => {
        mockMachineStateTable.getMachine.mockReturnValue(undefined);
        const response = apiHandler.handle({ method: HttpMethod.POST, path: `/machine/${machineId}/start`, token: VALID_TOKEN });
        expect(response.statusCode).toBe(HttpResponseCode.NOT_FOUND);
    });
  });

  describe('Routing', () => {
    it('should return INTERNAL_SERVER_ERROR for unknown paths', () => {
        const response = apiHandler.handle({ method: HttpMethod.GET, path: '/unknown/path', token: VALID_TOKEN });
        expect(response.statusCode).toBe(HttpResponseCode.INTERNAL_SERVER_ERROR);
    });
  });
});
